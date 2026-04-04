using MultiOutputAudioTester.Models;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace MultiOutputAudioTester.Services;

public sealed class AudioOutputPipeline : IDisposable
{
    private readonly object _statusSync = new();
    private readonly AppLogger _logger;
    private readonly MMDevice _device;
    private readonly string _deviceName;
    private readonly BufferedWaveProvider _bufferedProvider;
    private readonly AdaptiveResamplingSampleProvider _driftCorrectionProvider;
    private readonly DelaySampleProvider _delayProvider;
    private readonly MarkerMixingSampleProvider _markerProvider;
    private readonly VolumeSampleProvider _volumeProvider;
    private readonly MeteringSampleProvider _meteringProvider;
    private readonly WasapiOut _player;

    private const double TargetBufferMilliseconds = 260;
    private const double InitialStartBufferMilliseconds = 240;
    private const double ResumeBufferMilliseconds = 220;
    private const double DriftActivationBufferMilliseconds = 170;
    private const double RebufferThresholdMilliseconds = 28;
    private const double CriticalUnderrunThresholdMilliseconds = 12;
    private const double MaximumRateAdjustment = 0.0010;
    private const double MaximumCombinedRateAdjustment = 0.0025;
    private const double ControllerGain = 0.00075;

    private double _meterLevel;
    private double _currentPlaybackRate = 1.0;
    private double _bufferControlPlaybackRate = 1.0;
    private double _autoSyncPlaybackRate = 1.0;
    private string _statusText = "Idle";
    private DateTime _lastUnderrunWarningUtc = DateTime.MinValue;
    private double _routeVolumePercent;
    private double _masterVolumePercent = 100;
    private int _manualDelayMilliseconds;
    private int _autoDelayMilliseconds;
    private double _estimatedArrivalMilliseconds;
    private double _syncConfidence;
    private SyncLockState _syncLockState = SyncLockState.Disabled;
    private string _syncStatusText = "Manual";
    private bool _isTimingMaster;
    private double _markerLevelPercent;
    private bool _playRequested;
    private bool _playbackStarted;
    private bool _playbackFaulted;
    private bool _rebuffering;
    private DateTime _lastRebufferRequestUtc = DateTime.MinValue;

    public AudioOutputPipeline(int slotIndex, MMDevice device, OutputRouteConfig config, double masterVolumePercent, AppLogger logger)
    {
        SlotIndex = slotIndex;
        _device = device;
        _deviceName = device.FriendlyName;
        _logger = logger;
        _routeVolumePercent = Math.Clamp(config.VolumePercent, 0, 100);
        _masterVolumePercent = Math.Clamp(masterVolumePercent, 0, 100);
        _manualDelayMilliseconds = config.DelayMilliseconds;
        _isTimingMaster = config.IsTimingMaster;

        var internalFormat = WaveFormat.CreateIeeeFloatWaveFormat(48000, 2);
        _bufferedProvider = new BufferedWaveProvider(internalFormat)
        {
            BufferDuration = TimeSpan.FromSeconds(6),
            ReadFully = true,
            DiscardOnBufferOverflow = true
        };

        _driftCorrectionProvider = new AdaptiveResamplingSampleProvider(_bufferedProvider.ToSampleProvider());
        _delayProvider = new DelaySampleProvider(_driftCorrectionProvider);
        _delayProvider.DelayMilliseconds = _manualDelayMilliseconds;
        _markerProvider = new MarkerMixingSampleProvider(_delayProvider, slotIndex, 0);
        _markerProvider.DelayMilliseconds = _manualDelayMilliseconds;

        _volumeProvider = new VolumeSampleProvider(_markerProvider)
        {
            Volume = 1.0f
        };
        ApplyEffectiveVolume();

        _meteringProvider = new MeteringSampleProvider(_volumeProvider);
        _meteringProvider.StreamVolume += OnStreamVolume;

        _player = new WasapiOut(_device, AudioClientShareMode.Shared, true, 60);
        _player.PlaybackStopped += OnPlaybackStopped;
        _player.Init(_meteringProvider.ToWaveProvider());

        StatusText = "Ready";
    }

    public event EventHandler<OutputPipelineStatus>? StatusChanged;

    public event EventHandler<int>? RebufferRequested;

    public int SlotIndex { get; }

    public bool IsRebuffering => _rebuffering;

    public bool CanResumeFromRebuffer => _rebuffering && _bufferedProvider.BufferedDuration >= TimeSpan.FromMilliseconds(ResumeBufferMilliseconds);

    public bool IsTimingMaster => _isTimingMaster;

    public void Start()
    {
        _playRequested = true;
        _playbackStarted = false;
        _rebuffering = false;
        StatusText = "Priming";
        PublishStatus();
    }

    public void Stop()
    {
        _playRequested = false;
        _playbackStarted = false;
        _rebuffering = false;

        var playbackState = TryGetPlaybackState();
        if (playbackState is not null && playbackState != PlaybackState.Stopped)
        {
            try
            {
                _player.Stop();
            }
            catch (Exception ex)
            {
                _playbackFaulted = true;
                _logger.Warn($"Output {SlotIndex}: stop failed on '{_deviceName}': {ex.Message}");
            }
        }

        StatusText = "Stopped";
        PublishStatus();
    }

    public void AddSamples(byte[] buffer, int bytes)
    {
        if (bytes <= 0)
        {
            return;
        }

        try
        {
            _bufferedProvider.AddSamples(buffer, 0, bytes);
            TryStartPlayback();
        }
        catch (Exception ex)
        {
            StatusText = "Buffer write failed";
            PublishStatus();
            _logger.Error($"Output {SlotIndex}: failed to buffer audio for '{_deviceName}'.", ex);
        }
    }

    public void UpdateSettings(double volumePercent, int delayMilliseconds)
    {
        _routeVolumePercent = Math.Clamp(volumePercent, 0, 100);
        _manualDelayMilliseconds = Math.Clamp(delayMilliseconds, 0, 2000);
        ApplyEffectiveVolume();
        ApplyEffectiveDelay();
        PublishStatus();
    }

    public void UpdateMasterVolume(double masterVolumePercent)
    {
        _masterVolumePercent = Math.Clamp(masterVolumePercent, 0, 100);
        ApplyEffectiveVolume();
        PublishStatus();
    }

    public void UpdateAutoSyncState(
        int autoDelayMilliseconds,
        double autoSyncPlaybackRateRatio,
        double estimatedArrivalMilliseconds,
        double syncConfidence,
        SyncLockState syncLockState,
        string syncStatusText,
        double markerLevelPercent,
        bool isTimingMaster)
    {
        _autoDelayMilliseconds = Math.Clamp(autoDelayMilliseconds, 0, 2000);
        _autoSyncPlaybackRate = Math.Clamp(autoSyncPlaybackRateRatio, 0.9975, 1.0025);
        _estimatedArrivalMilliseconds = Math.Max(0, estimatedArrivalMilliseconds);
        _syncConfidence = Math.Clamp(syncConfidence, 0, 1);
        _syncLockState = syncLockState;
        _syncStatusText = syncStatusText;
        _isTimingMaster = isTimingMaster;
        _markerLevelPercent = Math.Clamp(markerLevelPercent, 0, 5);
        _markerProvider.MarkerLevelPercent = _markerLevelPercent;
        ApplyEffectiveDelay();
    }

    public void ResetAutoSyncState()
    {
        _autoDelayMilliseconds = 0;
        _autoSyncPlaybackRate = 1.0;
        _estimatedArrivalMilliseconds = 0;
        _syncConfidence = 0;
        _syncLockState = SyncLockState.Disabled;
        _syncStatusText = "Manual";
        _markerLevelPercent = 0;
        _markerProvider.MarkerLevelPercent = 0;
        ApplyEffectiveDelay();
        ApplyCombinedPlaybackRate();
    }

    public bool TryCopyRecentMarkerWindow(int delayFrames, int lengthFrames, float[] destination)
    {
        return _markerProvider.TryCopyRecentMarkerWindow(delayFrames, lengthFrames, destination);
    }

    public void PublishStatus()
    {
        TryStartPlayback();
        UpdateDriftCorrection();

        var playbackState = TryGetPlaybackState();
        if (_playbackStarted &&
            playbackState == PlaybackState.Playing &&
            _bufferedProvider.BufferedDuration < TimeSpan.FromMilliseconds(20) &&
            DateTime.UtcNow - _lastUnderrunWarningUtc > TimeSpan.FromSeconds(3))
        {
            _lastUnderrunWarningUtc = DateTime.UtcNow;
            _logger.Warn($"Output {SlotIndex}: low buffered audio on '{_deviceName}' ({_bufferedProvider.BufferedDuration.TotalMilliseconds:F0} ms).");
        }

        TryRequestRebuffer(playbackState);

        StatusChanged?.Invoke(this, new OutputPipelineStatus
        {
            SlotIndex = SlotIndex,
            MeterLevel = _meterLevel,
            BufferedMilliseconds = _bufferedProvider.BufferedDuration.TotalMilliseconds,
            PlaybackRateRatio = _currentPlaybackRate,
            AutoSyncPlaybackRateRatio = _autoSyncPlaybackRate,
            EffectiveDelayMilliseconds = _manualDelayMilliseconds + _autoDelayMilliseconds,
            AutoDelayMilliseconds = _autoDelayMilliseconds,
            EstimatedArrivalMilliseconds = _estimatedArrivalMilliseconds,
            SyncConfidence = _syncConfidence,
            MarkerLevelPercent = _markerLevelPercent,
            IsTimingMaster = _isTimingMaster,
            SyncLockState = _syncLockState,
            SyncStatusText = _syncStatusText,
            StatusText = StatusText
        });
    }

    public void Dispose()
    {
        _meteringProvider.StreamVolume -= OnStreamVolume;
        _player.PlaybackStopped -= OnPlaybackStopped;
        try
        {
            _player.Dispose();
        }
        catch (Exception ex)
        {
            _logger.Warn($"Output {SlotIndex}: dispose failed on '{_deviceName}': {ex.Message}");
        }

        try
        {
            _device.Dispose();
        }
        catch (Exception ex)
        {
            _logger.Warn($"Output {SlotIndex}: MMDevice dispose failed on '{_deviceName}': {ex.Message}");
        }
    }

    private string StatusText
    {
        get
        {
            lock (_statusSync)
            {
                return _statusText;
            }
        }
        set
        {
            lock (_statusSync)
            {
                _statusText = value;
            }
        }
    }

    private void OnStreamVolume(object? sender, StreamVolumeEventArgs e)
    {
        _meterLevel = e.MaxSampleValues.Length == 0 ? 0 : e.MaxSampleValues.Max();
    }

    private void ApplyEffectiveVolume()
    {
        var effectiveVolume = (_routeVolumePercent / 100.0) * (_masterVolumePercent / 100.0);
        _volumeProvider.Volume = (float)Math.Clamp(effectiveVolume, 0, 1);
    }

    private void UpdateDriftCorrection()
    {
        var playbackState = TryGetPlaybackState();
        if (_playbackFaulted || !_playbackStarted || _rebuffering || playbackState != PlaybackState.Playing)
        {
            _bufferControlPlaybackRate = 1.0;
            ApplyCombinedPlaybackRate();
            return;
        }

        var bufferedMs = _bufferedProvider.BufferedDuration.TotalMilliseconds;
        if (bufferedMs < DriftActivationBufferMilliseconds)
        {
            _bufferControlPlaybackRate += (1.0 - _bufferControlPlaybackRate) * 0.2;
            ApplyCombinedPlaybackRate();
            return;
        }

        var errorMs = bufferedMs - TargetBufferMilliseconds;
        var normalizedError = errorMs / TargetBufferMilliseconds;
        var desiredAdjustment = Math.Clamp(normalizedError * ControllerGain, -MaximumRateAdjustment, MaximumRateAdjustment);
        var desiredRate = 1.0 + desiredAdjustment;

        _bufferControlPlaybackRate += (desiredRate - _bufferControlPlaybackRate) * 0.08;
        _bufferControlPlaybackRate = Math.Clamp(_bufferControlPlaybackRate, 1.0 - MaximumRateAdjustment, 1.0 + MaximumRateAdjustment);
        ApplyCombinedPlaybackRate();
    }

    private void TryStartPlayback()
    {
        if (!_playRequested || _playbackFaulted)
        {
            return;
        }

        var requiredBufferMs = _rebuffering ? ResumeBufferMilliseconds : InitialStartBufferMilliseconds;
        if (_bufferedProvider.BufferedDuration < TimeSpan.FromMilliseconds(requiredBufferMs))
        {
            return;
        }

        var playbackState = TryGetPlaybackState();
        if (_playbackStarted && playbackState == PlaybackState.Playing)
        {
            return;
        }

        try
        {
            _player.Play();
            _playbackStarted = true;
            _rebuffering = false;
            StatusText = "Playing";
            _logger.Info(
                $"Output {SlotIndex}: started playback on '{_deviceName}' after buffering " +
                $"{_bufferedProvider.BufferedDuration.TotalMilliseconds:F0} ms.");
        }
        catch (Exception ex)
        {
            _playbackFaulted = true;
            _playbackStarted = false;
            StatusText = "Playback error";
            _logger.Error($"Output {SlotIndex}: failed to start playback on '{_deviceName}'.", ex);
        }
    }

    public void PauseForCoordinatedRebuffer()
    {
        if (!_playRequested || _playbackFaulted)
        {
            return;
        }

        var playbackState = TryGetPlaybackState();
        if (playbackState is null)
        {
            return;
        }

        try
        {
            if (playbackState == PlaybackState.Playing)
            {
                _player.Pause();
            }

            _rebuffering = true;
            _playbackStarted = false;
            _bufferControlPlaybackRate = 1.0;
            ApplyCombinedPlaybackRate();
            StatusText = _bufferedProvider.BufferedDuration.TotalMilliseconds <= CriticalUnderrunThresholdMilliseconds
                ? "Rebuffering after underrun"
                : "Rebuffering";
        }
        catch (Exception ex)
        {
            _playbackFaulted = true;
            StatusText = "Playback error";
            _logger.Error($"Output {SlotIndex}: failed to pause playback on '{_deviceName}' for coordinated rebuffering.", ex);
        }
    }

    private void TryRequestRebuffer(PlaybackState? playbackState)
    {
        if (!_playRequested || !_playbackStarted || _rebuffering || playbackState != PlaybackState.Playing)
        {
            return;
        }

        var bufferedMs = _bufferedProvider.BufferedDuration.TotalMilliseconds;
        if (bufferedMs > RebufferThresholdMilliseconds)
        {
            return;
        }

        if (DateTime.UtcNow - _lastRebufferRequestUtc < TimeSpan.FromSeconds(2))
        {
            return;
        }

        _lastRebufferRequestUtc = DateTime.UtcNow;
        RebufferRequested?.Invoke(this, SlotIndex);
    }

    private void OnPlaybackStopped(object? sender, StoppedEventArgs e)
    {
        _playbackStarted = false;
        _rebuffering = false;

        if (e.Exception is not null)
        {
            StatusText = "Playback error";
            _logger.Error($"Output {SlotIndex}: playback stopped unexpectedly for '{_deviceName}'.", e.Exception);
        }
        else
        {
            StatusText = "Stopped";
        }

        PublishStatus();
    }

    private PlaybackState? TryGetPlaybackState()
    {
        try
        {
            return _player.PlaybackState;
        }
        catch (Exception ex)
        {
            if (!_playbackFaulted)
            {
                _playbackFaulted = true;
                StatusText = "Playback error";
                _logger.Error($"Output {SlotIndex}: failed to query playback state on '{_deviceName}'.", ex);
            }

            return null;
        }
    }

    private void ApplyEffectiveDelay()
    {
        var effectiveDelay = Math.Clamp(_manualDelayMilliseconds + _autoDelayMilliseconds, 0, 2000);
        _delayProvider.DelayMilliseconds = effectiveDelay;
        _markerProvider.DelayMilliseconds = effectiveDelay;
    }

    private void ApplyCombinedPlaybackRate()
    {
        _currentPlaybackRate = Math.Clamp(
            _bufferControlPlaybackRate * _autoSyncPlaybackRate,
            1.0 - MaximumCombinedRateAdjustment,
            1.0 + MaximumCombinedRateAdjustment);

        _driftCorrectionProvider.PlaybackRate = _currentPlaybackRate;
    }
}
