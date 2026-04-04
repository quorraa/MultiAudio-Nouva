using MultiOutputAudioTester.Config;
using MultiOutputAudioTester.Models;
using MultiOutputAudioTester.Services;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using WebUI.Models;
using System.IO;
using System.Threading.Channels;

namespace WebUI.Services;

public sealed class AudioControlService : IHostedService, IAsyncDisposable
{
    private static readonly IReadOnlyList<LayoutOption> LayoutOptions =
    [
        new()
        {
            Id = "constellation",
            Name = "Constellation",
            Summary = "Best balance of wow factor, readability, and fast live control.",
            IsRecommended = true
        },
        new()
        {
            Id = "rack",
            Name = "Rack",
            Summary = "Dense operator layout for larger route counts and utilitarian sessions."
        },
        new()
        {
            Id = "compact",
            Name = "Compact Dock",
            Summary = "Minimal floating widget for second-screen monitoring and quick actions."
        }
    ];

    private const int MaxLogEntries = 160;
    private const int BroadcastDebounceMilliseconds = 33;
    private const int TelemetryDebounceMilliseconds = 16;

    private readonly AppLogger _logger;
    private readonly DeviceService _deviceService;
    private readonly ConfigurationService _configurationService;
    private readonly AudioEngineService _audioEngineService;
    private readonly CalibrationService _calibrationService;
    private readonly object _sync = new();
    private readonly object _subscriberSync = new();
    private readonly SemaphoreSlim _operationGate = new(1, 1);
    private readonly SemaphoreSlim _pingGate = new(1, 1);
    private readonly List<Channel<AudioDashboardState>> _subscribers = [];
    private readonly List<Channel<AudioTelemetryState>> _telemetrySubscribers = [];

    private readonly List<MutableOutputRouteState> _outputs = [];
    private readonly List<AudioDeviceInfo> _inputDevices = [];
    private readonly List<AudioDeviceInfo> _playbackDevices = [];
    private readonly List<LogEntry> _logEntries = [];

    private AppConfig _config = new();
    private string? _selectedInputDeviceId;
    private string? _selectedCalibrationInputDeviceId;
    private bool _useTestTone;
    private bool _isRunning;
    private bool _isCalibrating;
    private double _captureLevel;
    private double _roomMicLevel;
    private double _masterVolumePercent = 100;
    private double _markerLevelPercent = 1.6;
    private AutoSyncMode _autoSyncMode = AutoSyncMode.MonitorOnly;
    private string _captureStatusText = "Idle";
    private string _sessionStatusMessage = "Ready";
    private string _calibrationStatusMessage = "Calibration idle.";
    private string _calibrationProgressMessage = "Calibration idle.";
    private string _lastErrorMessage = string.Empty;
    private CancellationTokenSource? _saveDebounceCts;
    private CancellationTokenSource? _calibrationCts;
    private int _broadcastScheduled;
    private int _telemetryBroadcastScheduled;
    private long _stateRevision;
    private long _telemetryRevision;

    public AudioControlService(
        AppLogger logger,
        DeviceService deviceService,
        ConfigurationService configurationService,
        AudioEngineService audioEngineService,
        CalibrationService calibrationService)
    {
        _logger = logger;
        _deviceService = deviceService;
        _configurationService = configurationService;
        _audioEngineService = audioEngineService;
        _calibrationService = calibrationService;

        _logger.EntryLogged += OnEntryLogged;
        _audioEngineService.CaptureLevelChanged += OnCaptureLevelChanged;
        _audioEngineService.RoomMicLevelChanged += OnRoomMicLevelChanged;
        _audioEngineService.OutputStatusChanged += OnOutputStatusChanged;
        _audioEngineService.ErrorRaised += OnEngineErrorRaised;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        _config = await _configurationService.LoadAsync();

        lock (_sync)
        {
            ApplyConfigLocked(_config);
            RefreshDevicesLocked();
            _sessionStatusMessage = $"Config path: {_configurationService.ConfigPath}";
        }

        _logger.Info("WebUI control service booted.");
        ScheduleBroadcast(immediate: true);
        ScheduleTelemetryBroadcast(immediate: true);
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _saveDebounceCts?.Cancel();

        try
        {
            await _audioEngineService.StopAsync();
        }
        catch (Exception ex)
        {
            _logger.Warn($"WebUI shutdown ignored an audio stop error: {ex.Message}");
        }
    }

    public async ValueTask DisposeAsync()
    {
        _saveDebounceCts?.Cancel();
        _saveDebounceCts?.Dispose();
        _operationGate.Dispose();
        _pingGate.Dispose();

        _logger.EntryLogged -= OnEntryLogged;
        _audioEngineService.CaptureLevelChanged -= OnCaptureLevelChanged;
        _audioEngineService.RoomMicLevelChanged -= OnRoomMicLevelChanged;
        _audioEngineService.OutputStatusChanged -= OnOutputStatusChanged;
        _audioEngineService.ErrorRaised -= OnEngineErrorRaised;

        await _audioEngineService.DisposeAsync();
    }

    public AudioDashboardState GetState()
    {
        lock (_sync)
        {
            var lockedOutputCount = _outputs.Count(output => output.SyncLockState == SyncLockState.Locked);
            var lowConfidenceOutputCount = _outputs.Count(output => output.SyncLockState == SyncLockState.LowConfidence);
            var faultedOutputCount = _outputs.Count(output => output.SyncLockState == SyncLockState.Faulted);

            return new AudioDashboardState
            {
                StateRevision = _stateRevision,
                IsRunning = _isRunning,
                IsCalibrating = _isCalibrating,
                CanStart = !_isRunning && !_isCalibrating,
                CanStop = _isRunning,
                CanRefreshDevices = !_isRunning && !_isCalibrating,
                CanAddOutput = !_isRunning && !_isCalibrating,
                CanRunCalibration = !_isCalibrating,
                CanEditTopology = !_isRunning && !_isCalibrating,
                SelectedInputDeviceId = _selectedInputDeviceId,
                SelectedCalibrationInputDeviceId = _selectedCalibrationInputDeviceId,
                UseTestTone = _useTestTone,
                MasterVolumePercent = _masterVolumePercent,
                AutoSyncMode = _autoSyncMode,
                MarkerLevelPercent = _markerLevelPercent,
                CaptureLevel = _captureLevel,
                RoomMicLevel = _roomMicLevel,
                CaptureStatusText = _captureStatusText,
                SessionStatusMessage = _sessionStatusMessage,
                CalibrationStatusMessage = _calibrationStatusMessage,
                CalibrationProgressMessage = _calibrationProgressMessage,
                LastErrorMessage = _lastErrorMessage,
                ConfigPath = _configurationService.ConfigPath,
                AnySoloActive = _outputs.Any(output => output.IsSolo),
                LockedOutputCount = lockedOutputCount,
                LowConfidenceOutputCount = lowConfidenceOutputCount,
                FaultedOutputCount = faultedOutputCount,
                InputDevices = _inputDevices.Select(CloneDevice).ToList(),
                PlaybackDevices = _playbackDevices.Select(CloneDevice).ToList(),
                Outputs = _outputs.OrderBy(output => output.SlotIndex).Select(CloneOutput).ToList(),
                LogEntries = _logEntries.ToList(),
                LayoutOptions = LayoutOptions
            };
        }
    }

    public AudioTelemetryState GetTelemetryState()
    {
        lock (_sync)
        {
            return new AudioTelemetryState
            {
                TelemetryRevision = _telemetryRevision,
                IsRunning = _isRunning,
                IsCalibrating = _isCalibrating,
                CaptureLevel = _captureLevel,
                RoomMicLevel = _roomMicLevel,
                CaptureStatusText = _captureStatusText,
                SessionStatusMessage = _sessionStatusMessage,
                CalibrationStatusMessage = _calibrationStatusMessage,
                CalibrationProgressMessage = _calibrationProgressMessage,
                RecentCalibrationEntries = BuildRecentCalibrationEntriesLocked(),
                Outputs = _outputs
                    .OrderBy(output => output.SlotIndex)
                    .Select(CloneTelemetryOutput)
                    .ToList()
            };
        }
    }

    public ChannelReader<AudioDashboardState> Subscribe(CancellationToken cancellationToken)
    {
        var channel = Channel.CreateUnbounded<AudioDashboardState>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });

        lock (_subscriberSync)
        {
            _subscribers.Add(channel);
        }

        cancellationToken.Register(() => channel.Writer.TryComplete());
        channel.Writer.TryWrite(GetState());
        return channel.Reader;
    }

    public ChannelReader<AudioTelemetryState> SubscribeTelemetry(CancellationToken cancellationToken)
    {
        var channel = Channel.CreateUnbounded<AudioTelemetryState>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });

        lock (_subscriberSync)
        {
            _telemetrySubscribers.Add(channel);
        }

        cancellationToken.Register(() => channel.Writer.TryComplete());
        channel.Writer.TryWrite(GetTelemetryState());
        return channel.Reader;
    }

    public async Task<AudioDashboardState> RefreshDevicesAsync()
    {
        await _operationGate.WaitAsync();

        try
        {
            lock (_sync)
            {
                ThrowIfBusyForTopologyChangesLocked("Refresh devices is only available while the engine is stopped.");
                RefreshDevicesLocked();
            }

            SaveConfigSoon();
            ScheduleBroadcast(immediate: true);
            return GetState();
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task<AudioDashboardState> UpdateSettingsAsync(MainSettingsUpdateRequest request)
    {
        await _operationGate.WaitAsync();

        try
        {
            AutoSyncSettings? autoSyncSettingsToApply = null;
            string? roomMicDeviceId = null;
            int timingMasterSlotIndex = 1;
            double? masterVolumeToApply = null;

            lock (_sync)
            {
                ThrowIfCalibratingLocked();

                var normalizedInputId = NormalizeDeviceId(request.SelectedInputDeviceId);
                var normalizedCalibrationId = NormalizeDeviceId(request.SelectedCalibrationInputDeviceId);

                ValidateKnownInputDeviceLocked(normalizedInputId, "Selected input device was not found.");
                ValidateKnownInputDeviceLocked(normalizedCalibrationId, "Selected calibration microphone was not found.");

                if (_isRunning && !StringEquals(normalizedInputId, _selectedInputDeviceId))
                {
                    throw new InvalidOperationException("Change the capture input only while the engine is stopped.");
                }

                if (_isRunning && request.UseTestTone != _useTestTone)
                {
                    throw new InvalidOperationException("Toggle test tone mode only while the engine is stopped.");
                }

                _selectedInputDeviceId = normalizedInputId;
                _selectedCalibrationInputDeviceId = normalizedCalibrationId;
                _useTestTone = request.UseTestTone;
                _masterVolumePercent = Math.Clamp(request.MasterVolumePercent, 0, 100);
                _autoSyncMode = request.AutoSyncMode;
                _markerLevelPercent = Math.Clamp(request.MarkerLevelPercent, 0, 5);
                _lastErrorMessage = string.Empty;

                if (_isRunning)
                {
                    masterVolumeToApply = _masterVolumePercent;
                    autoSyncSettingsToApply = BuildAutoSyncSettingsLocked();
                    roomMicDeviceId = _selectedCalibrationInputDeviceId;
                    timingMasterSlotIndex = GetTimingMasterSlotIndexLocked();
                }
            }

            if (masterVolumeToApply.HasValue)
            {
                _audioEngineService.UpdateMasterVolume(masterVolumeToApply.Value);
            }

            if (autoSyncSettingsToApply is not null)
            {
                _audioEngineService.UpdateAutoSyncSettings(autoSyncSettingsToApply, roomMicDeviceId, timingMasterSlotIndex);
            }

            SaveConfigSoon();
            ScheduleBroadcast(immediate: true);
            return GetState();
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task<AudioDashboardState> AddOutputAsync()
    {
        await _operationGate.WaitAsync();

        try
        {
            lock (_sync)
            {
                ThrowIfBusyForTopologyChangesLocked("Outputs can only be added while the engine is stopped.");

                _outputs.Add(new MutableOutputRouteState
                {
                    SlotIndex = _outputs.Count + 1,
                    VolumePercent = 100,
                    DelayMilliseconds = 0,
                    IsTimingMaster = !_outputs.Any(output => output.IsTimingMaster)
                });

                NormalizeMasterSelectionLocked();
                UpdateOutputRemovalStateLocked();
                _lastErrorMessage = string.Empty;
            }

            SaveConfigSoon();
            ScheduleBroadcast(immediate: true);
            return GetState();
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task<AudioDashboardState> RemoveOutputAsync(int slotIndex)
    {
        await _operationGate.WaitAsync();

        try
        {
            lock (_sync)
            {
                ThrowIfBusyForTopologyChangesLocked("Outputs can only be removed while the engine is stopped.");

                var output = _outputs.FirstOrDefault(item => item.SlotIndex == slotIndex)
                    ?? throw new InvalidOperationException($"Output {slotIndex} was not found.");

                if (_outputs.Count <= 1)
                {
                    throw new InvalidOperationException("At least one output route must remain.");
                }

                _outputs.Remove(output);

                for (var index = 0; index < _outputs.Count; index++)
                {
                    _outputs[index].SlotIndex = index + 1;
                }

                NormalizeMasterSelectionLocked();
                UpdateOutputRemovalStateLocked();
                _lastErrorMessage = string.Empty;
            }

            SaveConfigSoon();
            ScheduleBroadcast(immediate: true);
            return GetState();
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task<AudioDashboardState> UpdateOutputAsync(int slotIndex, OutputUpdateRequest request)
    {
        await _operationGate.WaitAsync();

        try
        {
            AutoSyncSettings? autoSyncSettingsToApply = null;
            string? roomMicDeviceId = null;
            int timingMasterSlotIndex = 1;
            (int SlotIndex, double VolumePercent, int DelayMilliseconds)? outputUpdate = null;

            lock (_sync)
            {
                ThrowIfCalibratingLocked();

                var output = _outputs.FirstOrDefault(item => item.SlotIndex == slotIndex)
                    ?? throw new InvalidOperationException($"Output {slotIndex} was not found.");

                var normalizedDeviceId = NormalizeDeviceId(request.SelectedDeviceId);
                ValidateKnownPlaybackDeviceLocked(normalizedDeviceId, $"Playback device for output {slotIndex} was not found.");

                if (_isRunning && !StringEquals(output.SelectedDeviceId, normalizedDeviceId))
                {
                    throw new InvalidOperationException("Change playback device assignments only while the engine is stopped.");
                }

                output.SelectedDeviceId = normalizedDeviceId;
                output.VolumePercent = Math.Clamp(request.VolumePercent, 0, 100);
                output.DelayMilliseconds = Math.Clamp(request.DelayMilliseconds, 0, 2000);

                if (request.IsTimingMaster)
                {
                    foreach (var candidate in _outputs)
                    {
                        candidate.IsTimingMaster = candidate.SlotIndex == slotIndex;
                    }
                }
                else
                {
                    output.IsTimingMaster = !_outputs.Any(candidate => candidate.SlotIndex != slotIndex && candidate.IsTimingMaster);
                }

                EnsureNoDuplicatePlaybackAssignmentsLocked();
                NormalizeMasterSelectionLocked();
                _lastErrorMessage = string.Empty;

                if (_isRunning)
                {
                    outputUpdate = (output.SlotIndex, GetAppliedVolumeLocked(output), output.DelayMilliseconds);
                    autoSyncSettingsToApply = BuildAutoSyncSettingsLocked();
                    roomMicDeviceId = _selectedCalibrationInputDeviceId;
                    timingMasterSlotIndex = GetTimingMasterSlotIndexLocked();
                }
            }

            if (outputUpdate.HasValue)
            {
                _audioEngineService.UpdateOutputSettings(
                    outputUpdate.Value.SlotIndex,
                    outputUpdate.Value.VolumePercent,
                    outputUpdate.Value.DelayMilliseconds);
            }

            if (autoSyncSettingsToApply is not null)
            {
                _audioEngineService.UpdateAutoSyncSettings(autoSyncSettingsToApply, roomMicDeviceId, timingMasterSlotIndex);
            }

            SaveConfigSoon();
            ScheduleBroadcast(immediate: true);
            return GetState();
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task<AudioDashboardState> ToggleMuteAsync(int slotIndex)
    {
        await _operationGate.WaitAsync();

        try
        {
            bool shouldApplyRuntimeMix;

            lock (_sync)
            {
                ThrowIfCalibratingLocked();

                var output = _outputs.FirstOrDefault(item => item.SlotIndex == slotIndex)
                    ?? throw new InvalidOperationException($"Output {slotIndex} was not found.");

                output.IsMuted = !output.IsMuted;
                _lastErrorMessage = string.Empty;
                shouldApplyRuntimeMix = _isRunning;
            }

            if (shouldApplyRuntimeMix)
            {
                await ApplyRuntimeMixAsync();
            }

            ScheduleBroadcast(immediate: true);
            return GetState();
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task<AudioDashboardState> ToggleSoloAsync(int slotIndex)
    {
        await _operationGate.WaitAsync();

        try
        {
            bool shouldApplyRuntimeMix;

            lock (_sync)
            {
                ThrowIfCalibratingLocked();

                var output = _outputs.FirstOrDefault(item => item.SlotIndex == slotIndex)
                    ?? throw new InvalidOperationException($"Output {slotIndex} was not found.");

                output.IsSolo = !output.IsSolo;
                _lastErrorMessage = string.Empty;
                shouldApplyRuntimeMix = _isRunning;
            }

            if (shouldApplyRuntimeMix)
            {
                await ApplyRuntimeMixAsync();
            }

            ScheduleBroadcast(immediate: true);
            return GetState();
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task<AudioDashboardState> PingOutputAsync(int slotIndex)
    {
        await _operationGate.WaitAsync();

        try
        {
            string deviceId;
            string deviceName;

            lock (_sync)
            {
                ThrowIfCalibratingLocked();

                var output = _outputs.FirstOrDefault(item => item.SlotIndex == slotIndex)
                    ?? throw new InvalidOperationException($"Output {slotIndex} was not found.");

                deviceId = output.SelectedDeviceId
                    ?? throw new InvalidOperationException($"Output {slotIndex} does not have a playback device selected.");
                deviceName = _playbackDevices.FirstOrDefault(device => StringEquals(device.Id, deviceId))?.Name
                    ?? "selected device";
                _sessionStatusMessage = $"Pinging output {slotIndex}...";
            }

            await PlayPingAsync(deviceId);

            lock (_sync)
            {
                _sessionStatusMessage = $"Ping sent to output {slotIndex} ({deviceName}).";
            }

            ScheduleBroadcast(immediate: true);
            return GetState();
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task<AudioDashboardState> StartStreamingAsync()
    {
        await _operationGate.WaitAsync();

        try
        {
            await StartStreamingCoreAsync();
            SaveConfigSoon();
            ScheduleBroadcast(immediate: true);
            return GetState();
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task<AudioDashboardState> StopStreamingAsync()
    {
        await _operationGate.WaitAsync();

        try
        {
            await StopStreamingCoreAsync("Streaming stopped.", "Stopped");
            ScheduleBroadcast(immediate: true);
            return GetState();
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task<AudioDashboardState> RunCalibrationAsync()
    {
        await _operationGate.WaitAsync();

        try
        {
            bool wasRunning;
            List<OutputRouteConfig> outputConfigs;
            string calibrationInputId;
            CancellationTokenSource calibrationCts;

            lock (_sync)
            {
                if (_isCalibrating)
                {
                    throw new InvalidOperationException("Calibration is already running.");
                }

                _lastErrorMessage = string.Empty;
                outputConfigs = BuildValidatedOutputConfigsLocked("Select a playback device for every output route before running calibration.");
                calibrationInputId = _selectedCalibrationInputDeviceId
                    ?? throw new InvalidOperationException("Select a calibration microphone before running calibration.");

                wasRunning = _isRunning;
                _isCalibrating = true;
                UpdateOutputRemovalStateLocked();
                _calibrationStatusMessage = wasRunning
                    ? "Calibration running. Live stream paused while calibration audio plays."
                    : "Calibration running. Keep the microphone at the listening position and stay quiet.";
                _calibrationProgressMessage = "Preparing route measurements...";
                _sessionStatusMessage = wasRunning
                    ? "Pausing live stream for calibration..."
                    : "Running calibration bursts...";
                _calibrationCts?.Cancel();
                _calibrationCts?.Dispose();
                _calibrationCts = new CancellationTokenSource();
                calibrationCts = _calibrationCts;
            }

            ScheduleBroadcast(immediate: true);

            try
            {
                if (wasRunning)
                {
                    await StopStreamingCoreAsync("Live stream paused for calibration.", "Paused for calibration");
                }

                lock (_sync)
                {
                    _sessionStatusMessage = "Running calibration bursts...";
                    _calibrationProgressMessage = "Running route bursts and collecting measurements...";
                }

                ScheduleBroadcast(immediate: true);

                var result = await _calibrationService.RunCalibrationAsync(calibrationInputId, outputConfigs, calibrationCts.Token);
                var successful = result.Outputs.Where(output => output.Succeeded).OrderBy(output => output.SlotIndex).ToList();

                lock (_sync)
                {
                    if (successful.Count == 0)
                    {
                        _calibrationStatusMessage = "Calibration failed. No burst arrivals were detected.";
                        _sessionStatusMessage = "Calibration finished without usable measurements.";
                        _calibrationProgressMessage = "No stable route arrivals were detected.";
                        _lastErrorMessage = "No stable latency clusters were found. Check the latest diagnostics folder and logs before retrying.";
                    }
                    else
                    {
                        foreach (var output in successful)
                        {
                            var route = _outputs.First(item => item.SlotIndex == output.SlotIndex);
                            route.DelayMilliseconds = output.SuggestedDelayMilliseconds;
                        }

                        _calibrationStatusMessage = $"Calibration applied: {result.Summary}";
                        _sessionStatusMessage = "Calibration finished.";
                        _calibrationProgressMessage = $"Calibration complete: {result.Summary}";
                        _logger.Info($"Calibration summary: {result.Summary}");

                        var failed = result.Outputs.Where(output => !output.Succeeded).ToList();
                        _lastErrorMessage = failed.Count == 0
                            ? string.Empty
                            : string.Join(" | ", failed.Select(output => $"O{output.SlotIndex}: {output.Message}"));
                    }
                }

                SaveConfigSoon();
            }
            catch (OperationCanceledException)
            {
                lock (_sync)
                {
                    _calibrationStatusMessage = "Calibration canceled.";
                    _sessionStatusMessage = wasRunning
                        ? "Calibration canceled. Restoring live stream..."
                        : "Calibration canceled.";
                    _calibrationProgressMessage = "Calibration stopped before completion.";
                    _lastErrorMessage = string.Empty;
                }

                _logger.Warn("Calibration canceled by user.");
            }
            catch (Exception ex)
            {
                lock (_sync)
                {
                    _calibrationStatusMessage = "Calibration failed.";
                    _sessionStatusMessage = "Calibration failed.";
                    _calibrationProgressMessage = ex.Message;
                    _lastErrorMessage = ex.Message;
                }

                _logger.Error("Calibration request failed.", ex);
            }
            finally
            {
                if (wasRunning)
                {
                    try
                    {
                        lock (_sync)
                        {
                            _isCalibrating = false;
                            UpdateOutputRemovalStateLocked();
                            _sessionStatusMessage = "Restoring live stream after calibration...";
                            _calibrationProgressMessage = "Restoring live stream after calibration...";
                        }

                        await StartStreamingCoreAsync();

                        lock (_sync)
                        {
                            _sessionStatusMessage = "Streaming is live after calibration.";
                            _calibrationProgressMessage = "Streaming resumed.";
                        }
                    }
                    catch (Exception ex)
                    {
                        lock (_sync)
                        {
                            _calibrationStatusMessage = "Calibration finished, but stream restore failed.";
                            _sessionStatusMessage = "Stream restore failed after calibration.";
                            _calibrationProgressMessage = ex.Message;
                            _lastErrorMessage = ex.Message;
                        }

                        _logger.Error("Failed to restore live stream after calibration.", ex);
                    }
                }

                lock (_sync)
                {
                    if (ReferenceEquals(_calibrationCts, calibrationCts))
                    {
                        _calibrationCts = null;
                    }
                    calibrationCts.Dispose();
                    _isCalibrating = false;
                    if (string.IsNullOrWhiteSpace(_calibrationProgressMessage))
                    {
                        _calibrationProgressMessage = _calibrationStatusMessage;
                    }
                    UpdateOutputRemovalStateLocked();
                }

                ScheduleBroadcast(immediate: true);
            }

            return GetState();
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public Task<AudioDashboardState> CancelCalibrationAsync()
    {
        CancellationTokenSource? calibrationCts;

        lock (_sync)
        {
            if (!_isCalibrating)
            {
                throw new InvalidOperationException("Calibration is not running.");
            }

            calibrationCts = _calibrationCts;
            _calibrationStatusMessage = "Canceling calibration...";
            _sessionStatusMessage = "Stopping calibration...";
            _calibrationProgressMessage = "Stopping the active calibration run...";
            _lastErrorMessage = string.Empty;
        }

        calibrationCts?.Cancel();
        ScheduleBroadcast(immediate: true);
        return Task.FromResult(GetState());
    }

    private async Task StartStreamingCoreAsync()
    {
        List<OutputRouteConfig> outputConfigs;
        string? inputDeviceId;
        bool useTestTone;
        double masterVolumePercent;
        AutoSyncSettings autoSyncSettings;
        string? roomMicDeviceId;

        lock (_sync)
        {
            if (_isCalibrating)
            {
                throw new InvalidOperationException("Cannot start the engine while calibration is running.");
            }

            _lastErrorMessage = string.Empty;
            outputConfigs = BuildValidatedOutputConfigsLocked("Select a playback device for every output route before starting.");
            inputDeviceId = _selectedInputDeviceId;
            useTestTone = _useTestTone;
            masterVolumePercent = _masterVolumePercent;
            autoSyncSettings = BuildAutoSyncSettingsLocked();
            roomMicDeviceId = _selectedCalibrationInputDeviceId;
            _captureStatusText = useTestTone
                ? "Generating internal test tone"
                : $"Capturing from: {FindInputDeviceDisplayNameLocked(inputDeviceId) ?? "None"}";
            _sessionStatusMessage = "Starting audio engine...";
        }

        try
        {
            await _audioEngineService.StartAsync(
                inputDeviceId,
                outputConfigs,
                useTestTone,
                masterVolumePercent,
                autoSyncSettings,
                roomMicDeviceId);

            lock (_sync)
            {
                _isRunning = true;
                _sessionStatusMessage = "Streaming is live.";
                UpdateOutputRemovalStateLocked();
            }
        }
        catch (Exception ex)
        {
            lock (_sync)
            {
                _lastErrorMessage = ex.Message;
                _sessionStatusMessage = "Start failed.";
            }

            _logger.Error("Start request failed.", ex);
            throw;
        }
    }

    private async Task StopStreamingCoreAsync(string sessionStoppedMessage, string captureStoppedMessage)
    {
        lock (_sync)
        {
            _sessionStatusMessage = "Stopping audio engine...";
        }

        try
        {
            await _audioEngineService.StopAsync();

            lock (_sync)
            {
                _isRunning = false;
                _captureLevel = 0;
                _roomMicLevel = 0;
                _captureStatusText = captureStoppedMessage;
                _sessionStatusMessage = sessionStoppedMessage;
                UpdateOutputRemovalStateLocked();
            }
        }
        catch (Exception ex)
        {
            lock (_sync)
            {
                _lastErrorMessage = ex.Message;
            }

            _logger.Error("Stop request failed.", ex);
            throw;
        }
    }

    private void ApplyConfigLocked(AppConfig config)
    {
        config.EnsureDefaults();
        _config = config;
        _selectedInputDeviceId = NormalizeDeviceId(config.InputDeviceId);
        _selectedCalibrationInputDeviceId = NormalizeDeviceId(config.CalibrationInputDeviceId);
        _useTestTone = config.UseTestTone;
        _masterVolumePercent = Math.Clamp(config.MasterVolumePercent, 0, 100);
        _autoSyncMode = config.AutoSync.Mode;
        _markerLevelPercent = Math.Clamp(config.AutoSync.MarkerLevelPercent, 0, 5);
        _outputs.Clear();

        foreach (var output in config.Outputs)
        {
            _outputs.Add(new MutableOutputRouteState
            {
                SlotIndex = output.SlotIndex,
                SelectedDeviceId = NormalizeDeviceId(output.DeviceId),
                VolumePercent = Math.Clamp(output.VolumePercent, 0, 100),
                DelayMilliseconds = Math.Clamp(output.DelayMilliseconds, 0, 2000),
                IsTimingMaster = output.IsTimingMaster
            });
        }

        if (_outputs.Count == 0)
        {
            _outputs.Add(new MutableOutputRouteState
            {
                SlotIndex = 1,
                VolumePercent = 100,
                DelayMilliseconds = 0,
                IsTimingMaster = true
            });
        }

        NormalizeMasterSelectionLocked();
        UpdateOutputRemovalStateLocked();
    }

    private void RefreshDevicesLocked()
    {
        var inputs = _deviceService.GetInputDevices().ToList();
        var playbacks = _deviceService.GetPlaybackDevices().ToList();

        _inputDevices.Clear();
        _inputDevices.AddRange(inputs);

        _playbackDevices.Clear();
        _playbackDevices.AddRange(playbacks);

        _selectedInputDeviceId = ResolveExistingInputIdLocked(_selectedInputDeviceId);
        _selectedCalibrationInputDeviceId = ResolveExistingInputIdLocked(_selectedCalibrationInputDeviceId);

        foreach (var output in _outputs)
        {
            output.SelectedDeviceId = ResolveExistingPlaybackIdLocked(output.SelectedDeviceId);
        }

        EnsureNoDuplicatePlaybackAssignmentsLocked(allowUnassigned: true);
        NormalizeMasterSelectionLocked();
        UpdateOutputRemovalStateLocked();
        _lastErrorMessage = string.Empty;

        _logger.Info($"Refreshed devices. Inputs={inputs.Count}, outputs={playbacks.Count}.");
    }

    private void OnEntryLogged(object? sender, LogEntry entry)
    {
        lock (_sync)
        {
            _logEntries.Add(entry);
            while (_logEntries.Count > MaxLogEntries)
            {
                _logEntries.RemoveAt(0);
            }
        }

        ScheduleBroadcast();
        ScheduleTelemetryBroadcast();
    }

    private void OnCaptureLevelChanged(object? sender, float level)
    {
        lock (_sync)
        {
            _captureLevel = Math.Clamp(level, 0, 1);
        }

        ScheduleTelemetryBroadcast();
    }

    private void OnRoomMicLevelChanged(object? sender, float level)
    {
        lock (_sync)
        {
            _roomMicLevel = Math.Clamp(level, 0, 1);
        }

        ScheduleTelemetryBroadcast();
    }

    private void OnOutputStatusChanged(object? sender, OutputPipelineStatus status)
    {
        lock (_sync)
        {
            var output = _outputs.FirstOrDefault(item => item.SlotIndex == status.SlotIndex);
            if (output is null)
            {
                return;
            }

            output.MeterLevel = Math.Clamp(status.MeterLevel, 0, 1);
            output.StatusText = status.StatusText;
            output.BufferedMilliseconds = status.BufferedMilliseconds;
            output.PlaybackRateRatio = status.PlaybackRateRatio;
            output.AutoSyncPlaybackRateRatio = status.AutoSyncPlaybackRateRatio;
            output.EffectiveDelayMilliseconds = status.EffectiveDelayMilliseconds;
            output.AutoDelayMilliseconds = status.AutoDelayMilliseconds;
            output.EstimatedArrivalMilliseconds = status.EstimatedArrivalMilliseconds;
            output.SyncConfidence = status.SyncConfidence;
            output.MarkerLevelPercent = status.MarkerLevelPercent;
            output.SyncLockState = status.SyncLockState;
            output.SyncStatusText = status.SyncStatusText;
            output.IsTimingMaster = status.IsTimingMaster;
        }

        ScheduleTelemetryBroadcast();
    }

    private void OnEngineErrorRaised(object? sender, string message)
    {
        lock (_sync)
        {
            _lastErrorMessage = message;
        }

        ScheduleBroadcast(immediate: true);
    }

    private void ScheduleBroadcast(bool immediate = false)
    {
        ScheduleTelemetryBroadcast(immediate);

        if (immediate)
        {
            BroadcastState();
            return;
        }

        if (Interlocked.Exchange(ref _broadcastScheduled, 1) != 0)
        {
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(BroadcastDebounceMilliseconds);
                BroadcastState();
            }
            finally
            {
                Interlocked.Exchange(ref _broadcastScheduled, 0);
            }
        });
    }

    private void ScheduleTelemetryBroadcast(bool immediate = false)
    {
        if (immediate)
        {
            BroadcastTelemetry();
            return;
        }

        if (Interlocked.Exchange(ref _telemetryBroadcastScheduled, 1) != 0)
        {
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TelemetryDebounceMilliseconds);
                BroadcastTelemetry();
            }
            finally
            {
                Interlocked.Exchange(ref _telemetryBroadcastScheduled, 0);
            }
        });
    }

    private void BroadcastState()
    {
        AudioDashboardState snapshot;
        List<Channel<AudioDashboardState>> subscribers;

        lock (_sync)
        {
            _stateRevision++;
            snapshot = GetState();
        }

        lock (_subscriberSync)
        {
            subscribers = _subscribers.ToList();
        }

        if (subscribers.Count == 0)
        {
            return;
        }

        var stale = new List<Channel<AudioDashboardState>>();
        foreach (var subscriber in subscribers)
        {
            if (!subscriber.Writer.TryWrite(snapshot))
            {
                stale.Add(subscriber);
            }
        }

        if (stale.Count == 0)
        {
            return;
        }

        lock (_subscriberSync)
        {
            foreach (var subscriber in stale)
            {
                _subscribers.Remove(subscriber);
            }
        }
    }

    private void BroadcastTelemetry()
    {
        AudioTelemetryState snapshot;
        List<Channel<AudioTelemetryState>> subscribers;

        lock (_sync)
        {
            _telemetryRevision++;
            snapshot = GetTelemetryState();
        }

        lock (_subscriberSync)
        {
            subscribers = _telemetrySubscribers.ToList();
        }

        if (subscribers.Count == 0)
        {
            return;
        }

        var stale = new List<Channel<AudioTelemetryState>>();
        foreach (var subscriber in subscribers)
        {
            if (!subscriber.Writer.TryWrite(snapshot))
            {
                stale.Add(subscriber);
            }
        }

        if (stale.Count == 0)
        {
            return;
        }

        lock (_subscriberSync)
        {
            foreach (var subscriber in stale)
            {
                _telemetrySubscribers.Remove(subscriber);
            }
        }
    }

    private void ThrowIfBusyForTopologyChangesLocked(string message)
    {
        if (_isRunning || _isCalibrating)
        {
            throw new InvalidOperationException(message);
        }
    }

    private void ThrowIfCalibratingLocked()
    {
        if (_isCalibrating)
        {
            throw new InvalidOperationException("Wait for calibration to finish before changing settings.");
        }
    }

    private AutoSyncSettings BuildAutoSyncSettingsLocked()
    {
        return new AutoSyncSettings
        {
            Mode = _autoSyncMode,
            MarkerLevelPercent = _markerLevelPercent
        };
    }

    private int GetTimingMasterSlotIndexLocked()
    {
        return _outputs.FirstOrDefault(output => output.IsTimingMaster)?.SlotIndex ?? 1;
    }

    private List<OutputRouteConfig> BuildValidatedOutputConfigsLocked(string missingDeviceMessage)
    {
        if (_outputs.Count == 0)
        {
            throw new InvalidOperationException("At least one output route is required.");
        }

        var masterSlotIndex = GetTimingMasterSlotIndexLocked();
        var outputConfigs = _outputs
            .OrderBy(output => output.SlotIndex)
            .Select(output => new OutputRouteConfig
            {
                SlotIndex = output.SlotIndex,
                DeviceId = output.SelectedDeviceId,
                VolumePercent = GetAppliedVolumeLocked(output),
                DelayMilliseconds = output.DelayMilliseconds,
                IsTimingMaster = output.SlotIndex == masterSlotIndex
            })
            .ToList();

        if (outputConfigs.Any(output => string.IsNullOrWhiteSpace(output.DeviceId)))
        {
            throw new InvalidOperationException(missingDeviceMessage);
        }

        var duplicates = outputConfigs
            .GroupBy(output => output.DeviceId, StringComparer.OrdinalIgnoreCase)
            .Where(group => !string.IsNullOrWhiteSpace(group.Key) && group.Count() > 1)
            .ToList();

        if (duplicates.Count > 0)
        {
            throw new InvalidOperationException("Each output route must use a different playback device.");
        }

        return outputConfigs;
    }

    private void EnsureNoDuplicatePlaybackAssignmentsLocked(bool allowUnassigned = false)
    {
        var duplicates = _outputs
            .Where(output => allowUnassigned || !string.IsNullOrWhiteSpace(output.SelectedDeviceId))
            .Where(output => !string.IsNullOrWhiteSpace(output.SelectedDeviceId))
            .GroupBy(output => output.SelectedDeviceId, StringComparer.OrdinalIgnoreCase)
            .Where(group => group.Count() > 1)
            .ToList();

        if (duplicates.Count > 0)
        {
            throw new InvalidOperationException("Each output route must use a different playback device.");
        }
    }

    private void NormalizeMasterSelectionLocked()
    {
        if (_outputs.Count == 0)
        {
            return;
        }

        var master = _outputs.FirstOrDefault(output => output.IsTimingMaster) ?? _outputs[0];
        foreach (var output in _outputs)
        {
            output.IsTimingMaster = output.SlotIndex == master.SlotIndex;
        }
    }

    private void UpdateOutputRemovalStateLocked()
    {
        var canRemove = !_isRunning && !_isCalibrating && _outputs.Count > 1;
        foreach (var output in _outputs)
        {
            output.CanRemove = canRemove;
        }
    }

    private bool AnySoloActiveLocked()
    {
        return _outputs.Any(output => output.IsSolo);
    }

    private double GetAppliedVolumeLocked(MutableOutputRouteState output)
    {
        if (output.IsMuted)
        {
            return 0;
        }

        var anySoloActive = AnySoloActiveLocked();
        if (anySoloActive && !output.IsSolo)
        {
            return 0;
        }

        return output.VolumePercent;
    }

    private async Task ApplyRuntimeMixAsync()
    {
        List<(int SlotIndex, double VolumePercent, int DelayMilliseconds)> runtimeUpdates;

        lock (_sync)
        {
            runtimeUpdates = _outputs
                .OrderBy(output => output.SlotIndex)
                .Select(output => (output.SlotIndex, GetAppliedVolumeLocked(output), output.DelayMilliseconds))
                .ToList();
        }

        foreach (var update in runtimeUpdates)
        {
            _audioEngineService.UpdateOutputSettings(update.SlotIndex, update.VolumePercent, update.DelayMilliseconds);
        }
    }

    private async Task PlayPingAsync(string deviceId)
    {
        await _pingGate.WaitAsync();

        try
        {
            using var enumerator = new MMDeviceEnumerator();
            using var outputDevice = enumerator.GetDevice(deviceId);
            if (outputDevice.State != DeviceState.Active)
            {
                throw new InvalidOperationException($"Output device '{outputDevice.FriendlyName}' is not active.");
            }

            var signal = CreatePingSignal();
            var format = WaveFormat.CreateIeeeFloatWaveFormat(48000, 2);
            var stopTcs = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);

            using var player = new WasapiOut(outputDevice, AudioClientShareMode.Shared, true, 60);
            EventHandler<StoppedEventArgs>? handler = null;
            handler = (_, args) =>
            {
                if (args.Exception is not null)
                {
                    stopTcs.TrySetException(args.Exception);
                }
                else
                {
                    stopTcs.TrySetResult(null);
                }
            };

            player.PlaybackStopped += handler;

            try
            {
                using var stream = new MemoryStream(signal, writable: false);
                using var waveStream = new RawSourceWaveStream(stream, format);
                player.Init(waveStream);
                player.Play();
                await stopTcs.Task;
            }
            finally
            {
                player.PlaybackStopped -= handler;
            }
        }
        finally
        {
            _pingGate.Release();
        }
    }

    private static byte[] CreatePingSignal()
    {
        const int sampleRate = 48000;
        const int channels = 2;
        const double durationSeconds = 0.24;
        const double amplitude = 0.22;
        const double frequency = 880.0;
        const int fadeSamples = 800;

        var frameCount = (int)(sampleRate * durationSeconds);
        var samples = new float[frameCount * channels];

        for (var frame = 0; frame < frameCount; frame++)
        {
            var envelope = 1.0;
            if (frame < fadeSamples)
            {
                envelope = frame / (double)fadeSamples;
            }
            else if (frame >= frameCount - fadeSamples)
            {
                envelope = (frameCount - frame) / (double)fadeSamples;
            }

            var sample = (float)(Math.Sin(frame * Math.PI * 2 * frequency / sampleRate) * amplitude * envelope);
            var offset = frame * channels;
            samples[offset] = sample;
            samples[offset + 1] = sample;
        }

        var bytes = new byte[samples.Length * sizeof(float)];
        Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
        return bytes;
    }

    private string? ResolveExistingInputIdLocked(string? deviceId)
    {
        if (!string.IsNullOrWhiteSpace(deviceId) &&
            _inputDevices.Any(device => StringEquals(device.Id, deviceId)))
        {
            return deviceId;
        }

        return _inputDevices.FirstOrDefault(device => device.IsActive)?.Id
            ?? _inputDevices.FirstOrDefault()?.Id;
    }

    private string? ResolveExistingPlaybackIdLocked(string? deviceId)
    {
        if (!string.IsNullOrWhiteSpace(deviceId) &&
            _playbackDevices.Any(device => StringEquals(device.Id, deviceId)))
        {
            return deviceId;
        }

        return null;
    }

    private string? FindInputDeviceDisplayNameLocked(string? deviceId)
    {
        return _inputDevices.FirstOrDefault(device => StringEquals(device.Id, deviceId))?.DisplayName;
    }

    private void ValidateKnownInputDeviceLocked(string? deviceId, string message)
    {
        if (!string.IsNullOrWhiteSpace(deviceId) &&
            !_inputDevices.Any(device => StringEquals(device.Id, deviceId)))
        {
            throw new InvalidOperationException(message);
        }
    }

    private void ValidateKnownPlaybackDeviceLocked(string? deviceId, string message)
    {
        if (!string.IsNullOrWhiteSpace(deviceId) &&
            !_playbackDevices.Any(device => StringEquals(device.Id, deviceId)))
        {
            throw new InvalidOperationException(message);
        }
    }

    private static AudioDeviceInfo CloneDevice(AudioDeviceInfo device)
    {
        return new AudioDeviceInfo
        {
            Id = device.Id,
            Name = device.Name,
            State = device.State,
            IsActive = device.IsActive
        };
    }

    private OutputRouteState CloneOutput(MutableOutputRouteState output)
    {
        var deviceName = _playbackDevices.FirstOrDefault(device => StringEquals(device.Id, output.SelectedDeviceId))?.DisplayName
            ?? "Unassigned";

        return new OutputRouteState
        {
            SlotIndex = output.SlotIndex,
            SelectedDeviceId = output.SelectedDeviceId,
            SelectedDeviceName = deviceName,
            VolumePercent = output.VolumePercent,
            AppliedVolumePercent = GetAppliedVolumeLocked(output),
            DelayMilliseconds = output.DelayMilliseconds,
            IsTimingMaster = output.IsTimingMaster,
            IsMuted = output.IsMuted,
            IsSolo = output.IsSolo,
            MeterLevel = output.MeterLevel,
            StatusText = output.StatusText,
            BufferedMilliseconds = output.BufferedMilliseconds,
            PlaybackRateRatio = output.PlaybackRateRatio,
            AutoSyncPlaybackRateRatio = output.AutoSyncPlaybackRateRatio,
            EffectiveDelayMilliseconds = output.EffectiveDelayMilliseconds,
            AutoDelayMilliseconds = output.AutoDelayMilliseconds,
            EstimatedArrivalMilliseconds = output.EstimatedArrivalMilliseconds,
            SyncConfidence = output.SyncConfidence,
            MarkerLevelPercent = output.MarkerLevelPercent,
            SyncLockState = output.SyncLockState,
            SyncStatusText = output.SyncStatusText,
            SyncSummary = $"{output.SyncLockState}: {output.SyncStatusText}",
            CanRemove = output.CanRemove
        };
    }

    private OutputTelemetryState CloneTelemetryOutput(MutableOutputRouteState output)
    {
        return new OutputTelemetryState
        {
            SlotIndex = output.SlotIndex,
            MeterLevel = output.MeterLevel,
            StatusText = output.StatusText,
            AppliedVolumePercent = GetAppliedVolumeLocked(output),
            DelayMilliseconds = output.DelayMilliseconds,
            EffectiveDelayMilliseconds = output.EffectiveDelayMilliseconds,
            SyncConfidence = output.SyncConfidence,
            SyncLockState = output.SyncLockState,
            SyncSummary = $"{output.SyncLockState}: {output.SyncStatusText}",
            IsMuted = output.IsMuted,
            IsSolo = output.IsSolo
        };
    }

    private List<CalibrationTelemetryEntry> BuildRecentCalibrationEntriesLocked()
    {
        return _logEntries
            .Where(entry => entry.DisplayText.Contains("Calibration sample", StringComparison.OrdinalIgnoreCase)
                || entry.DisplayText.Contains("Calibration result", StringComparison.OrdinalIgnoreCase)
                || entry.DisplayText.Contains("Calibration summary", StringComparison.OrdinalIgnoreCase)
                || entry.DisplayText.Contains("Calibration diagnostics saved", StringComparison.OrdinalIgnoreCase)
                || entry.DisplayText.Contains("Calibration failed", StringComparison.OrdinalIgnoreCase)
                || entry.DisplayText.Contains("stable latency", StringComparison.OrdinalIgnoreCase)
                || entry.DisplayText.Contains("burst", StringComparison.OrdinalIgnoreCase))
            .TakeLast(10)
            .Select(entry => new CalibrationTelemetryEntry
            {
                Time = entry.DisplayText.Length >= 8 ? entry.DisplayText[..8] : string.Empty,
                Text = StripLogPrefix(entry.DisplayText),
                Tone = entry.DisplayText.Contains("[ERROR]", StringComparison.OrdinalIgnoreCase)
                    || entry.DisplayText.Contains("failed", StringComparison.OrdinalIgnoreCase)
                    ? "danger"
                    : entry.DisplayText.Contains("[WARN]", StringComparison.OrdinalIgnoreCase)
                        || entry.DisplayText.Contains("weak", StringComparison.OrdinalIgnoreCase)
                        || entry.DisplayText.Contains("no stable", StringComparison.OrdinalIgnoreCase)
                        ? "warn"
                        : "neutral"
            })
            .Reverse()
            .ToList();
    }

    private static string StripLogPrefix(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length <= 8)
        {
            return value;
        }

        var closingBracketIndex = value.IndexOf("] ", StringComparison.Ordinal);
        if (closingBracketIndex >= 0 && closingBracketIndex + 2 < value.Length)
        {
            return value[(closingBracketIndex + 2)..];
        }

        return value;
    }

    private void SaveConfigSoon()
    {
        CancellationTokenSource cts;
        AppConfig configToSave;

        lock (_sync)
        {
            _config = BuildConfigLocked();
            configToSave = _config;
            _saveDebounceCts?.Cancel();
            _saveDebounceCts?.Dispose();
            _saveDebounceCts = new CancellationTokenSource();
            cts = _saveDebounceCts;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(350, cts.Token);
                await _configurationService.SaveAsync(configToSave);
            }
            catch (OperationCanceledException)
            {
            }
            finally
            {
                cts.Dispose();
                lock (_sync)
                {
                    if (ReferenceEquals(_saveDebounceCts, cts))
                    {
                        _saveDebounceCts = null;
                    }
                }
            }
        });
    }

    private AppConfig BuildConfigLocked()
    {
        return new AppConfig
        {
            InputDeviceId = _selectedInputDeviceId,
            CalibrationInputDeviceId = _selectedCalibrationInputDeviceId,
            UseTestTone = _useTestTone,
            MasterVolumePercent = _masterVolumePercent,
            AutoSync = BuildAutoSyncSettingsLocked(),
            Outputs = _outputs
                .OrderBy(output => output.SlotIndex)
                .Select(output => new OutputRouteConfig
                {
                    SlotIndex = output.SlotIndex,
                    DeviceId = output.SelectedDeviceId,
                    VolumePercent = output.VolumePercent,
                    DelayMilliseconds = output.DelayMilliseconds,
                    IsTimingMaster = output.IsTimingMaster
                })
                .ToList()
        };
    }

    private static string? NormalizeDeviceId(string? deviceId)
    {
        return string.IsNullOrWhiteSpace(deviceId)
            ? null
            : deviceId.Trim();
    }

    private static bool StringEquals(string? left, string? right)
    {
        return string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class MutableOutputRouteState
    {
        public int SlotIndex { get; set; }

        public string? SelectedDeviceId { get; set; }

        public double VolumePercent { get; set; } = 100;

        public int DelayMilliseconds { get; set; }

        public bool IsTimingMaster { get; set; }

        public bool IsMuted { get; set; }

        public bool IsSolo { get; set; }

        public double MeterLevel { get; set; }

        public string StatusText { get; set; } = "Idle";

        public double BufferedMilliseconds { get; set; }

        public double PlaybackRateRatio { get; set; } = 1.0;

        public double AutoSyncPlaybackRateRatio { get; set; } = 1.0;

        public int EffectiveDelayMilliseconds { get; set; }

        public int AutoDelayMilliseconds { get; set; }

        public double EstimatedArrivalMilliseconds { get; set; }

        public double SyncConfidence { get; set; }

        public double MarkerLevelPercent { get; set; }

        public SyncLockState SyncLockState { get; set; } = SyncLockState.Disabled;

        public string SyncStatusText { get; set; } = "Manual";

        public bool CanRemove { get; set; }
    }
}
