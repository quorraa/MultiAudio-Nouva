using MultiOutputAudioTester.Models;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace MultiOutputAudioTester.Services;

public sealed class AudioEngineService : IAsyncDisposable
{
    private readonly AppLogger _logger;
    private readonly LiveAutoSyncService _liveAutoSyncService;
    private readonly List<AudioOutputPipeline> _outputPipelines = [];
    private readonly object _sync = new();
    private readonly WaveFormat _internalFormat = WaveFormat.CreateIeeeFloatWaveFormat(48000, 2);

    private CancellationTokenSource? _runCts;
    private Task? _pumpTask;
    private Task? _monitorTask;
    private WasapiCapture? _capture;
    private MMDevice? _captureDevice;
    private BufferedWaveProvider? _captureBuffer;
    private ISampleProvider? _normalizedProvider;
    private bool _isRunning;
    private bool _coordinatedRebufferActive;
    private bool _manualSyncTickEnabled;
    private float[] _manualSyncMixScratch = Array.Empty<float>();
    private long _manualSyncTickFrame;
    private long _manualSyncTickGeneration;

    public AudioEngineService(AppLogger logger)
    {
        _logger = logger;
        _liveAutoSyncService = new LiveAutoSyncService(logger);
        _liveAutoSyncService.RoomMicLevelChanged += OnRoomMicLevelChanged;
        _liveAutoSyncService.ErrorRaised += OnAutoSyncErrorRaised;
    }

    public event EventHandler<float>? CaptureLevelChanged;

    public event EventHandler<float>? RoomMicLevelChanged;

    public event EventHandler<OutputPipelineStatus>? OutputStatusChanged;

    public event EventHandler<string>? ErrorRaised;

    public bool IsRunning
    {
        get
        {
            lock (_sync)
            {
                return _isRunning;
            }
        }
    }

    public async Task StartAsync(
        string? inputDeviceId,
        IReadOnlyList<OutputRouteConfig> outputs,
        bool useTestTone,
        double masterVolumePercent,
        AutoSyncSettings autoSyncSettings,
        string? roomMicDeviceId)
    {
        await StopAsync();

        if (outputs.Count == 0)
        {
            throw new InvalidOperationException("At least one output route is required.");
        }

        _runCts = new CancellationTokenSource();
        _coordinatedRebufferActive = false;

        try
        {
            using var enumerator = new MMDeviceEnumerator();

            foreach (var output in outputs.OrderBy(route => route.SlotIndex))
            {
                if (string.IsNullOrWhiteSpace(output.DeviceId))
                {
                    throw new InvalidOperationException($"Output {output.SlotIndex} does not have a selected device.");
                }

                var outputDevice = enumerator.GetDevice(output.DeviceId);
                if (outputDevice.State != DeviceState.Active)
                {
                    throw new InvalidOperationException($"Output device '{outputDevice.FriendlyName}' is not active.");
                }

                var pipeline = new AudioOutputPipeline(output.SlotIndex, outputDevice, output, masterVolumePercent, _logger);
                pipeline.StatusChanged += OnOutputStatusChanged;
                pipeline.RebufferRequested += OnPipelineRebufferRequested;
                _outputPipelines.Add(pipeline);
            }

            foreach (var pipeline in _outputPipelines)
            {
                pipeline.Start();
            }

            if (useTestTone)
            {
                _pumpTask = Task.Run(() => RunTestToneAsync(_runCts.Token));
                _logger.Info("Engine started in internal test tone mode.");
            }
            else
            {
                if (string.IsNullOrWhiteSpace(inputDeviceId))
                {
                    throw new InvalidOperationException("An input device must be selected when test tone mode is off.");
                }

                var inputDevice = enumerator.GetDevice(inputDeviceId);
                if (inputDevice.State != DeviceState.Active)
                {
                    throw new InvalidOperationException($"Input device '{inputDevice.FriendlyName}' is not active.");
                }

                InitializeCapture(inputDevice);
                _pumpTask = Task.Run(() => RunCapturePumpAsync(_runCts.Token));
            }

            _monitorTask = Task.Run(() => MonitorOutputsAsync(_runCts.Token));
            await _liveAutoSyncService.StartAsync(roomMicDeviceId, _outputPipelines, autoSyncSettings, _runCts.Token);

            lock (_sync)
            {
                _isRunning = true;
            }
        }
        catch (Exception ex)
        {
            _logger.Error("Audio engine failed to start.", ex);
            ErrorRaised?.Invoke(this, ex.Message);
            await StopAsync();
            throw;
        }
    }

    public async Task StopAsync()
    {
        CancellationTokenSource? ctsToCancel;
        Task? pumpTask;
        Task? monitorTask;
        WasapiCapture? capture;
        MMDevice? captureDevice;

        lock (_sync)
        {
            ctsToCancel = _runCts;
            _runCts = null;
            pumpTask = _pumpTask;
            _pumpTask = null;
            monitorTask = _monitorTask;
            _monitorTask = null;
            capture = _capture;
            _capture = null;
            captureDevice = _captureDevice;
            _captureDevice = null;
            _captureBuffer = null;
            _normalizedProvider = null;
            _isRunning = false;
            _coordinatedRebufferActive = false;
            ResetManualSyncTickLocked();
        }

        ctsToCancel?.Cancel();
        await _liveAutoSyncService.StopAsync();

        if (capture is not null)
        {
            capture.DataAvailable -= OnCaptureDataAvailable;
            capture.RecordingStopped -= OnCaptureStopped;
            try
            {
                capture.StopRecording();
            }
            catch (Exception ex)
            {
                _logger.Warn($"Capture stop threw an exception: {ex.Message}");
            }

            capture.Dispose();
        }

        captureDevice?.Dispose();

        if (pumpTask is not null)
        {
            try
            {
                await pumpTask;
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception ex)
            {
                _logger.Warn($"Pump task stopped with an exception: {ex.Message}");
            }
        }

        if (monitorTask is not null)
        {
            try
            {
                await monitorTask;
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception ex)
            {
                _logger.Warn($"Monitor task stopped with an exception: {ex.Message}");
            }
        }

        foreach (var pipeline in _outputPipelines)
        {
            pipeline.StatusChanged -= OnOutputStatusChanged;
            pipeline.RebufferRequested -= OnPipelineRebufferRequested;

            try
            {
                pipeline.Stop();
            }
            catch (Exception ex)
            {
                _logger.Warn($"Stop ignored an output pipeline exception: {ex.Message}");
            }

            try
            {
                pipeline.Dispose();
            }
            catch (Exception ex)
            {
                _logger.Warn($"Dispose ignored an output pipeline exception: {ex.Message}");
            }
        }

        _outputPipelines.Clear();
        CaptureLevelChanged?.Invoke(this, 0);
        ctsToCancel?.Dispose();
    }

    public void UpdateOutputSettings(int slotIndex, double volumePercent, int delayMilliseconds)
    {
        var pipeline = _outputPipelines.FirstOrDefault(item => item.SlotIndex == slotIndex);
        pipeline?.UpdateSettings(volumePercent, delayMilliseconds);
    }

    public void UpdateMasterVolume(double masterVolumePercent)
    {
        foreach (var pipeline in _outputPipelines)
        {
            pipeline.UpdateMasterVolume(masterVolumePercent);
        }
    }

    public void UpdateAutoSyncSettings(AutoSyncSettings settings, string? roomMicDeviceId, int timingMasterSlotIndex)
    {
        _liveAutoSyncService.UpdateSettings(settings, roomMicDeviceId, timingMasterSlotIndex);

        if (!settings.IsEnabled)
        {
            _ = _liveAutoSyncService.StopAsync();
            return;
        }

        if (!_liveAutoSyncService.IsRunning && _runCts is not null && _outputPipelines.Count > 0)
        {
            _ = _liveAutoSyncService.StartAsync(roomMicDeviceId, _outputPipelines, settings, _runCts.Token);
        }
    }

    public void UpdateManualSyncTick(bool enabled)
    {
        lock (_sync)
        {
            _manualSyncTickEnabled = enabled;
            if (!enabled)
            {
                ResetManualSyncTickLocked();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        _liveAutoSyncService.RoomMicLevelChanged -= OnRoomMicLevelChanged;
        _liveAutoSyncService.ErrorRaised -= OnAutoSyncErrorRaised;
        await _liveAutoSyncService.DisposeAsync();
    }

    private void InitializeCapture(MMDevice inputDevice)
    {
        _captureDevice = inputDevice;
        _capture = new WasapiCapture(inputDevice);
        _capture.DataAvailable += OnCaptureDataAvailable;
        _capture.RecordingStopped += OnCaptureStopped;

        _captureBuffer = new BufferedWaveProvider(_capture.WaveFormat)
        {
            BufferDuration = TimeSpan.FromSeconds(4),
            ReadFully = false,
            DiscardOnBufferOverflow = true
        };

        var sampleProvider = _captureBuffer.ToSampleProvider();
        sampleProvider = sampleProvider.WaveFormat.Channels switch
        {
            1 => new MonoToStereoSampleProvider(sampleProvider),
            2 => sampleProvider,
            _ => new ChannelMapSampleProvider(sampleProvider)
        };

        _normalizedProvider = sampleProvider.WaveFormat.SampleRate == _internalFormat.SampleRate
            ? sampleProvider
            : new WdlResamplingSampleProvider(sampleProvider, _internalFormat.SampleRate);

        _capture.StartRecording();
        _logger.Info($"Capturing from '{inputDevice.FriendlyName}' using shared mode format {_capture.WaveFormat}.");
    }

    private void OnCaptureDataAvailable(object? sender, WaveInEventArgs e)
    {
        try
        {
            _captureBuffer?.AddSamples(e.Buffer, 0, e.BytesRecorded);
        }
        catch (Exception ex)
        {
            _logger.Error("Failed to queue captured audio into the internal buffer.", ex);
        }
    }

    private void OnCaptureStopped(object? sender, StoppedEventArgs e)
    {
        if (e.Exception is not null)
        {
            _logger.Error("Capture stopped unexpectedly.", e.Exception);
            ErrorRaised?.Invoke(this, e.Exception.Message);
        }
    }

    private async Task RunCapturePumpAsync(CancellationToken cancellationToken)
    {
        if (_normalizedProvider is null)
        {
            return;
        }

        var chunkFrames = _internalFormat.SampleRate / 100;
        var sampleBuffer = new float[chunkFrames * _internalFormat.Channels];
        var byteBuffer = new byte[sampleBuffer.Length * sizeof(float)];

        while (!cancellationToken.IsCancellationRequested)
        {
            var read = _normalizedProvider.Read(sampleBuffer, 0, sampleBuffer.Length);
            if (read <= 0)
            {
                CaptureLevelChanged?.Invoke(this, 0);
                await Task.Delay(5, cancellationToken);
                continue;
            }

            DispatchSamples(sampleBuffer, read, byteBuffer);
        }
    }

    private async Task RunTestToneAsync(CancellationToken cancellationToken)
    {
        var chunkFrames = _internalFormat.SampleRate / 100;
        var sampleBuffer = new float[chunkFrames * _internalFormat.Channels];
        var byteBuffer = new byte[sampleBuffer.Length * sizeof(float)];
        const double frequency = 440.0;
        const double amplitude = 0.2;
        double phase = 0;
        var phaseStep = Math.PI * 2 * frequency / _internalFormat.SampleRate;

        while (!cancellationToken.IsCancellationRequested)
        {
            for (var frame = 0; frame < chunkFrames; frame++)
            {
                var sample = (float)(Math.Sin(phase) * amplitude);
                phase += phaseStep;
                if (phase > Math.PI * 2)
                {
                    phase -= Math.PI * 2;
                }

                var index = frame * _internalFormat.Channels;
                sampleBuffer[index] = sample;
                sampleBuffer[index + 1] = sample;
            }

            DispatchSamples(sampleBuffer, sampleBuffer.Length, byteBuffer);
            await Task.Delay(10, cancellationToken);
        }
    }

    private void DispatchSamples(float[] sampleBuffer, int samplesRead, byte[] byteBuffer)
    {
        bool tickEnabled;
        long startFrame, generation;
        lock (_sync)
        {
            tickEnabled = _manualSyncTickEnabled;
            startFrame = _manualSyncTickFrame;
            generation = _manualSyncTickGeneration;
        }
        if (!tickEnabled)
            Buffer.BlockCopy(sampleBuffer, 0, byteBuffer, 0, samplesRead * sizeof(float));

        foreach (var pipeline in _outputPipelines)
        {
            if (tickEnabled)
            {
                var dispatchBuffer = ApplyManualSyncTick(sampleBuffer, samplesRead, startFrame, pipeline.SlotIndex);
                lock (_sync)
                {
                    if (!_manualSyncTickEnabled || generation != _manualSyncTickGeneration)
                        dispatchBuffer = sampleBuffer;
                }
                // AddSamples copies the bytes before this scratch buffer is reused.
                Buffer.BlockCopy(dispatchBuffer, 0, byteBuffer, 0, samplesRead * sizeof(float));
            }
            pipeline.AddSamples(byteBuffer, samplesRead * sizeof(float));
        }
        lock (_sync)
        {
            // Advance once per source block, never once per output.
            if (tickEnabled && _manualSyncTickEnabled && generation == _manualSyncTickGeneration)
                _manualSyncTickFrame = startFrame + samplesRead / _internalFormat.Channels;
        }

        var peak = 0f;
        for (var index = 0; index < samplesRead; index++)
        {
            var value = Math.Abs(sampleBuffer[index]);
            if (value > peak)
            {
                peak = value;
            }
        }

        CaptureLevelChanged?.Invoke(this, peak);
    }

    public int ManualSyncTickBeat
    {
        get
        {
            lock (_sync)
                return _manualSyncTickEnabled
                    ? SyncTickPattern.BeatAt(Math.Max(0, _manualSyncTickFrame - 1), _internalFormat.SampleRate)
                    : 0;
        }
    }

    private float[] ApplyManualSyncTick(float[] sourceBuffer, int samplesRead, long startFrame, int slotIndex)
    {
        if (_manualSyncMixScratch.Length < samplesRead)
            _manualSyncMixScratch = new float[samplesRead];
        Array.Copy(sourceBuffer, _manualSyncMixScratch, samplesRead);
        var framesRead = samplesRead / _internalFormat.Channels;
        for (var frame = 0; frame < framesRead; frame++)
        {
            var tick = SyncTickPattern.SampleAt(startFrame + frame, _internalFormat.SampleRate, slotIndex);
            if (tick == 0) continue;
            for (var channel = 0; channel < _internalFormat.Channels; channel++)
            {
                var index = frame * _internalFormat.Channels + channel;
                _manualSyncMixScratch[index] = Math.Clamp(_manualSyncMixScratch[index] + tick, -1f, 1f);
            }
        }

        return _manualSyncMixScratch;
    }

    private void ResetManualSyncTickLocked()
    {
        _manualSyncTickEnabled = false;
        _manualSyncTickFrame = 0;
        _manualSyncTickGeneration++;
    }

    private async Task MonitorOutputsAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(500));
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            UpdateOutputBufferSyncTargets();

            if (_coordinatedRebufferActive && _outputPipelines.Count > 0 && _outputPipelines.All(pipeline => pipeline.CanResumeFromRebuffer))
            {
                foreach (var pipeline in _outputPipelines)
                {
                    pipeline.PublishStatus();
                }

                _coordinatedRebufferActive = false;
                _logger.Info("All outputs rebuilt enough buffer. Resuming coordinated playback.");
            }

            foreach (var pipeline in _outputPipelines)
            {
                pipeline.PublishStatus();
            }
        }
    }

    private void UpdateOutputBufferSyncTargets()
    {
        if (_outputPipelines.Count == 0)
        {
            return;
        }

        var timingMaster = _outputPipelines.FirstOrDefault(pipeline => pipeline.IsTimingMaster)
            ?? _outputPipelines[0];
        var masterBufferedMilliseconds = timingMaster.BufferedMilliseconds;

        foreach (var pipeline in _outputPipelines)
        {
            pipeline.UpdateBufferSyncTarget(
                ReferenceEquals(pipeline, timingMaster)
                    ? null
                    : masterBufferedMilliseconds);
        }
    }

    private void OnOutputStatusChanged(object? sender, OutputPipelineStatus e)
    {
        OutputStatusChanged?.Invoke(this, e);
    }

    private void OnPipelineRebufferRequested(object? sender, int slotIndex)
    {
        if (_coordinatedRebufferActive || _outputPipelines.Count == 0)
        {
            return;
        }

        _coordinatedRebufferActive = true;
        _logger.Warn($"Output {slotIndex} triggered coordinated rebuffering. Pausing all outputs to preserve sync.");

        foreach (var pipeline in _outputPipelines)
        {
            pipeline.PauseForCoordinatedRebuffer();
            pipeline.PublishStatus();
        }
    }

    private void OnRoomMicLevelChanged(object? sender, float e)
    {
        RoomMicLevelChanged?.Invoke(this, e);
    }

    private void OnAutoSyncErrorRaised(object? sender, string e)
    {
        ErrorRaised?.Invoke(this, e);
    }
}
