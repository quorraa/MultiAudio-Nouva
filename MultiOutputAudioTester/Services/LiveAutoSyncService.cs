using MultiOutputAudioTester.Models;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace MultiOutputAudioTester.Services;

public sealed class LiveAutoSyncService : IAsyncDisposable
{
    private const int InternalSampleRate = 48000;
    private const int AnalysisWindowMilliseconds = 180;
    private const int StartupSearchMinimumMilliseconds = 20;
    private const int StartupSearchMaximumMilliseconds = 950;
    private const int LockedSearchRadiusMilliseconds = 90;
    private const double MinimumCorrelationScore = 0.008;
    private const double MinimumPeakSeparation = 0.003;
    private const double MinimumUsableConfidence = 0.2;
    private const double LockedConfidenceThreshold = 0.45;
    private const double MaximumAutoRateTrim = 0.0015;
    private const double AutoRateControllerGain = 0.00003;
    private const double FastDelayStepMilliseconds = 6.0;
    private const double LockedDelayStepMilliseconds = 1.5;

    private readonly AppLogger _logger;
    private readonly RecentSampleHistory _micHistory = new(InternalSampleRate * 12);
    private readonly List<RouteTracker> _routes = [];
    private readonly object _sync = new();

    private CancellationTokenSource? _runCts;
    private Task? _micPumpTask;
    private Task? _analysisTask;
    private WasapiCapture? _roomCapture;
    private BufferedWaveProvider? _roomCaptureBuffer;
    private ISampleProvider? _roomNormalizedProvider;
    private AutoSyncSettings _settings = new();
    private string? _roomMicDeviceId;
    private bool _roomMicWarningLogged;
    private bool _pendingMicChangeWarning;

    public LiveAutoSyncService(AppLogger logger)
    {
        _logger = logger;
    }

    public event EventHandler<float>? RoomMicLevelChanged;

    public event EventHandler<string>? ErrorRaised;

    public bool IsRunning { get; private set; }

    public async Task StartAsync(
        string? roomMicDeviceId,
        IReadOnlyList<AudioOutputPipeline> pipelines,
        AutoSyncSettings settings,
        CancellationToken externalCancellationToken)
    {
        await StopAsync();

        _settings = settings.Clone();
        _roomMicDeviceId = roomMicDeviceId;
        _roomMicWarningLogged = false;
        _pendingMicChangeWarning = false;
        _micHistory.Clear();
        _routes.Clear();
        _runCts = CancellationTokenSource.CreateLinkedTokenSource(externalCancellationToken);

        foreach (var pipeline in pipelines.OrderBy(pipeline => pipeline.SlotIndex))
        {
            var route = new RouteTracker(pipeline)
            {
                IsTimingMaster = pipeline.IsTimingMaster
            };
            _routes.Add(route);
        }

        ApplyRouteStates(resetToManual: !_settings.IsEnabled);
        if (!_settings.IsEnabled)
        {
            _logger.Info("Live auto-sync is off. Playback will use manual delay and existing buffer control only.");
            return;
        }

        if (string.IsNullOrWhiteSpace(roomMicDeviceId))
        {
            SetRoutesWaitingForMic("Select a room microphone to enable live auto-sync.");
            return;
        }

        try
        {
            using var enumerator = new MMDeviceEnumerator();
            var roomMic = enumerator.GetDevice(roomMicDeviceId);
            if (roomMic.State != DeviceState.Active)
            {
                SetRoutesWaitingForMic($"Room microphone '{roomMic.FriendlyName}' is not active.");
                return;
            }

            InitializeRoomMicCapture(roomMic);
            _micPumpTask = Task.Run(() => RunRoomMicPumpAsync(_runCts.Token));
            _analysisTask = Task.Run(() => RunAnalysisLoopAsync(_runCts.Token));
            IsRunning = true;
            _logger.Info($"Live auto-sync started using room mic '{roomMic.FriendlyName}'.");
        }
        catch (Exception ex)
        {
            _logger.Error("Failed to start live auto-sync. Falling back to manual sync.", ex);
            ErrorRaised?.Invoke(this, ex.Message);
            SetRoutesFaulted("Auto-sync fallback: room mic could not start.");
            await StopAsync();
        }
    }

    public void UpdateSettings(AutoSyncSettings settings, string? roomMicDeviceId, int timingMasterSlotIndex)
    {
        var micChanged = _roomMicDeviceId != roomMicDeviceId;
        _settings = settings.Clone();
        _roomMicDeviceId = roomMicDeviceId;

        foreach (var route in _routes)
        {
            route.IsTimingMaster = route.SlotIndex == timingMasterSlotIndex;
        }

        if (!_settings.IsEnabled)
        {
            ApplyRouteStates(resetToManual: true);
            return;
        }

        foreach (var route in _routes)
        {
            route.Pipeline.UpdateAutoSyncState(
                (int)Math.Round(route.CurrentAutoDelayMilliseconds),
                route.CurrentAutoRateRatio,
                route.FilteredArrivalMilliseconds,
                route.Confidence,
                route.LockState,
                route.StatusText,
                _settings.MarkerLevelPercent,
                route.IsTimingMaster);
        }

        if (IsRunning && micChanged && !_pendingMicChangeWarning)
        {
            _pendingMicChangeWarning = true;
            _logger.Warn("Changing the room mic while streaming takes effect on the next engine start.");
        }
    }

    public async Task StopAsync()
    {
        CancellationTokenSource? cts;
        Task? micPumpTask;
        Task? analysisTask;
        WasapiCapture? capture;

        lock (_sync)
        {
            cts = _runCts;
            _runCts = null;
            micPumpTask = _micPumpTask;
            _micPumpTask = null;
            analysisTask = _analysisTask;
            _analysisTask = null;
            capture = _roomCapture;
            _roomCapture = null;
            _roomCaptureBuffer = null;
            _roomNormalizedProvider = null;
            IsRunning = false;
        }

        cts?.Cancel();

        if (capture is not null)
        {
            capture.DataAvailable -= OnRoomCaptureDataAvailable;
            capture.RecordingStopped -= OnRoomCaptureStopped;
            try
            {
                capture.StopRecording();
            }
            catch
            {
            }

            capture.Dispose();
        }

        if (micPumpTask is not null)
        {
            try
            {
                await micPumpTask;
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception ex)
            {
                _logger.Warn($"Room mic pump stopped with an exception: {ex.Message}");
            }
        }

        if (analysisTask is not null)
        {
            try
            {
                await analysisTask;
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception ex)
            {
                _logger.Warn($"Auto-sync analysis stopped with an exception: {ex.Message}");
            }
        }

        RoomMicLevelChanged?.Invoke(this, 0);
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
    }

    private void InitializeRoomMicCapture(MMDevice roomMic)
    {
        _roomCapture = new WasapiCapture(roomMic);
        _roomCapture.DataAvailable += OnRoomCaptureDataAvailable;
        _roomCapture.RecordingStopped += OnRoomCaptureStopped;

        _roomCaptureBuffer = new BufferedWaveProvider(_roomCapture.WaveFormat)
        {
            BufferDuration = TimeSpan.FromSeconds(4),
            ReadFully = false,
            DiscardOnBufferOverflow = true
        };

        ISampleProvider sampleProvider = _roomCaptureBuffer.ToSampleProvider();
        sampleProvider = sampleProvider.WaveFormat.Channels switch
        {
            1 => sampleProvider,
            2 => sampleProvider,
            _ => new ChannelMapSampleProvider(sampleProvider)
        };

        if (sampleProvider.WaveFormat.SampleRate != InternalSampleRate)
        {
            sampleProvider = new WdlResamplingSampleProvider(sampleProvider, InternalSampleRate);
        }

        if (sampleProvider.WaveFormat.Channels == 2)
        {
            sampleProvider = new StereoToMonoSampleProvider(sampleProvider)
            {
                LeftVolume = 0.5f,
                RightVolume = 0.5f
            };
        }

        _roomNormalizedProvider = sampleProvider;
        _roomCapture.StartRecording();
    }

    private void OnRoomCaptureDataAvailable(object? sender, WaveInEventArgs e)
    {
        try
        {
            _roomCaptureBuffer?.AddSamples(e.Buffer, 0, e.BytesRecorded);
        }
        catch (Exception ex)
        {
            _logger.Error("Failed to queue room mic audio.", ex);
        }
    }

    private void OnRoomCaptureStopped(object? sender, StoppedEventArgs e)
    {
        if (e.Exception is null)
        {
            return;
        }

        _logger.Error("Room mic capture stopped unexpectedly.", e.Exception);
        ErrorRaised?.Invoke(this, e.Exception.Message);
        SetRoutesFaulted("Room mic capture faulted.");
    }

    private async Task RunRoomMicPumpAsync(CancellationToken cancellationToken)
    {
        if (_roomNormalizedProvider is null)
        {
            return;
        }

        var buffer = new float[InternalSampleRate / 100];
        while (!cancellationToken.IsCancellationRequested)
        {
            var read = _roomNormalizedProvider.Read(buffer, 0, buffer.Length);
            if (read <= 0)
            {
                RoomMicLevelChanged?.Invoke(this, 0);
                await Task.Delay(5, cancellationToken);
                continue;
            }

            _micHistory.Append(buffer.AsSpan(0, read));

            float peak = 0;
            for (var index = 0; index < read; index++)
            {
                var sample = Math.Abs(buffer[index]);
                if (sample > peak)
                {
                    peak = sample;
                }
            }

            RoomMicLevelChanged?.Invoke(this, peak);
        }
    }

    private async Task RunAnalysisLoopAsync(CancellationToken cancellationToken)
    {
        var analysisWindowFrames = InternalSampleRate * AnalysisWindowMilliseconds / 1000;
        var micWindow = new float[analysisWindowFrames];
        var referenceWindow = new float[analysisWindowFrames];

        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            if (!_micHistory.TryCopyLatestWindow(0, analysisWindowFrames, micWindow))
            {
                continue;
            }

            var nowUtc = DateTime.UtcNow;
            foreach (var route in _routes)
            {
                if (TryMeasureRoute(route, micWindow, referenceWindow, out var measuredArrivalMs, out var confidence))
                {
                    UpdateTrackerMeasurement(route, measuredArrivalMs, confidence, nowUtc);
                }
                else
                {
                    RegisterMeasurementMiss(route);
                }
            }

            ApplyCorrections(nowUtc);
        }
    }

    private bool TryMeasureRoute(RouteTracker route, float[] micWindow, float[] referenceWindow, out double measuredArrivalMs, out double confidence)
    {
        measuredArrivalMs = 0;
        confidence = 0;

        var stepMilliseconds = route.HasEstimate ? 1 : 2;
        var minSearch = route.HasEstimate
            ? Math.Max(StartupSearchMinimumMilliseconds, (int)Math.Round(route.FilteredArrivalMilliseconds) - LockedSearchRadiusMilliseconds)
            : StartupSearchMinimumMilliseconds;
        var maxSearch = route.HasEstimate
            ? Math.Min(StartupSearchMaximumMilliseconds, (int)Math.Round(route.FilteredArrivalMilliseconds) + LockedSearchRadiusMilliseconds)
            : StartupSearchMaximumMilliseconds;

        var bestScore = double.NegativeInfinity;
        var bestDelayMilliseconds = 0;

        for (var candidateDelayMs = minSearch; candidateDelayMs <= maxSearch; candidateDelayMs += stepMilliseconds)
        {
            var candidateDelayFrames = candidateDelayMs * InternalSampleRate / 1000;
            if (!route.Pipeline.TryCopyRecentMarkerWindow(candidateDelayFrames, referenceWindow.Length, referenceWindow))
            {
                continue;
            }

            var score = ComputeNormalizedCorrelation(micWindow, referenceWindow);
            if (score > bestScore)
            {
                bestScore = score;
                bestDelayMilliseconds = candidateDelayMs;
            }
        }

        if (double.IsNegativeInfinity(bestScore))
        {
            route.StatusText = "Waiting for enough marker history.";
            return false;
        }

        var secondBestScore = double.NegativeInfinity;
        for (var candidateDelayMs = minSearch; candidateDelayMs <= maxSearch; candidateDelayMs += stepMilliseconds)
        {
            if (Math.Abs(candidateDelayMs - bestDelayMilliseconds) <= 8)
            {
                continue;
            }

            var candidateDelayFrames = candidateDelayMs * InternalSampleRate / 1000;
            if (!route.Pipeline.TryCopyRecentMarkerWindow(candidateDelayFrames, referenceWindow.Length, referenceWindow))
            {
                continue;
            }

            var score = ComputeNormalizedCorrelation(micWindow, referenceWindow);
            if (score > secondBestScore)
            {
                secondBestScore = score;
            }
        }

        secondBestScore = double.IsNegativeInfinity(secondBestScore) ? 0 : secondBestScore;
        if (bestScore < MinimumCorrelationScore || bestScore - secondBestScore < MinimumPeakSeparation)
        {
            route.StatusText = $"Marker detection weak (score {bestScore:F3}).";
            return false;
        }

        measuredArrivalMs = bestDelayMilliseconds;
        confidence = Math.Clamp(((bestScore - MinimumCorrelationScore) * 12.0) + ((bestScore - secondBestScore) * 18.0), 0, 1);
        return true;
    }

    private static double ComputeNormalizedCorrelation(float[] left, float[] right)
    {
        double sumLeft = 0;
        double sumRight = 0;
        double sumLeftSquared = 0;
        double sumRightSquared = 0;
        double sumCross = 0;

        for (var index = 0; index < left.Length; index++)
        {
            var x = left[index];
            var y = right[index];
            sumLeft += x;
            sumRight += y;
            sumLeftSquared += x * x;
            sumRightSquared += y * y;
            sumCross += x * y;
        }

        var count = left.Length;
        var covariance = sumCross - ((sumLeft * sumRight) / count);
        var leftVariance = sumLeftSquared - ((sumLeft * sumLeft) / count);
        var rightVariance = sumRightSquared - ((sumRight * sumRight) / count);
        if (leftVariance <= double.Epsilon || rightVariance <= double.Epsilon)
        {
            return 0;
        }

        return covariance / Math.Sqrt(leftVariance * rightVariance);
    }

    private void UpdateTrackerMeasurement(RouteTracker route, double measuredArrivalMs, double confidence, DateTime nowUtc)
    {
        var previousArrival = route.FilteredArrivalMilliseconds;
        if (!route.HasEstimate)
        {
            route.FilteredArrivalMilliseconds = measuredArrivalMs;
            route.HasEstimate = true;
        }
        else
        {
            var alpha = route.LockState == SyncLockState.Locked ? 0.12 : 0.28;
            route.FilteredArrivalMilliseconds += (measuredArrivalMs - route.FilteredArrivalMilliseconds) * alpha;
        }

        if (route.LastMeasurementUtc != default)
        {
            var elapsedSeconds = Math.Max(0.001, (nowUtc - route.LastMeasurementUtc).TotalSeconds);
            var arrivalDelta = route.FilteredArrivalMilliseconds - previousArrival;
            route.DriftEstimateMillisecondsPerSecond =
                (route.DriftEstimateMillisecondsPerSecond * 0.8) + ((arrivalDelta / elapsedSeconds) * 0.2);
        }

        route.LastMeasurementUtc = nowUtc;
        route.ConsecutiveGoodMeasurements++;
        route.ConsecutiveMisses = 0;
        route.Confidence = route.Confidence <= 0
            ? confidence
            : (route.Confidence * 0.65) + (confidence * 0.35);

        if (route.ConsecutiveGoodMeasurements >= 4 && route.Confidence >= LockedConfidenceThreshold)
        {
            route.LockState = SyncLockState.Locked;
                route.StatusText = route.IsTimingMaster
                    ? "Locked as timing anchor."
                    : "Locked on room arrival.";
        }
        else
        {
            route.LockState = SyncLockState.Converging;
            route.StatusText = "Converging on room arrival.";
        }
    }

    private void RegisterMeasurementMiss(RouteTracker route)
    {
        route.ConsecutiveMisses++;
        route.ConsecutiveGoodMeasurements = 0;
        route.Confidence *= 0.88;

        if (!route.HasEstimate)
        {
            route.LockState = SyncLockState.Listening;
            route.StatusText = "Listening for marker.";
            return;
        }

        route.LockState = SyncLockState.LowConfidence;
        route.StatusText = "Low confidence. Holding previous correction.";
    }

    private void ApplyCorrections(DateTime nowUtc)
    {
        var usableRoutes = _routes
            .Where(route => route.HasEstimate &&
                            route.Confidence >= MinimumUsableConfidence &&
                            nowUtc - route.LastMeasurementUtc < TimeSpan.FromSeconds(2))
            .ToList();

        if (usableRoutes.Count == 0)
        {
            foreach (var route in _routes)
            {
                route.Pipeline.UpdateAutoSyncState(
                    (int)Math.Round(route.CurrentAutoDelayMilliseconds),
                    route.CurrentAutoRateRatio,
                    route.FilteredArrivalMilliseconds,
                    route.Confidence,
                    route.LockState,
                    route.StatusText,
                    _settings.MarkerLevelPercent,
                    route.IsTimingMaster);
            }

            return;
        }

        var targetArrivalMilliseconds = usableRoutes.Max(route => route.FilteredArrivalMilliseconds);

        foreach (var route in _routes)
        {
            if (route.HasEstimate && _settings.AllowsControl)
            {
                var desiredAutoDelay = Math.Max(0, targetArrivalMilliseconds - route.FilteredArrivalMilliseconds);
                var stepLimit = route.LockState == SyncLockState.Locked
                    ? LockedDelayStepMilliseconds
                    : FastDelayStepMilliseconds;

                route.CurrentAutoDelayMilliseconds += Math.Clamp(
                    desiredAutoDelay - route.CurrentAutoDelayMilliseconds,
                    -stepLimit,
                    stepLimit);
            }

            if (!_settings.AllowsControl)
            {
                route.CurrentAutoDelayMilliseconds += (0 - route.CurrentAutoDelayMilliseconds) * 0.35;
                route.CurrentAutoRateRatio += (1.0 - route.CurrentAutoRateRatio) * 0.2;
                if (route.HasEstimate)
                {
                    route.StatusText = route.LockState switch
                    {
                        SyncLockState.Locked => "Monitoring only. Observation is stable.",
                        SyncLockState.LowConfidence => "Monitoring only. Low confidence.",
                        _ => "Monitoring only. Listening."
                    };
                }
            }
            else if (route.IsTimingMaster)
            {
                route.CurrentAutoRateRatio += (1.0 - route.CurrentAutoRateRatio) * 0.16;
            }
            else if (route.HasEstimate && route.Confidence >= MinimumUsableConfidence)
            {
                var alignedArrival = route.FilteredArrivalMilliseconds + route.CurrentAutoDelayMilliseconds;
                var residualError = alignedArrival - targetArrivalMilliseconds;
                route.CurrentAutoRateRatio += Math.Clamp(
                    -residualError * AutoRateControllerGain,
                    -0.00012,
                    0.00012);

                route.CurrentAutoRateRatio = Math.Clamp(
                    route.CurrentAutoRateRatio,
                    1.0 - MaximumAutoRateTrim,
                    1.0 + MaximumAutoRateTrim);

                if (Math.Abs(residualError) < 2)
                {
                    route.CurrentAutoRateRatio += (1.0 - route.CurrentAutoRateRatio) * 0.08;
                }
            }
            else
            {
                route.CurrentAutoRateRatio += (1.0 - route.CurrentAutoRateRatio) * 0.08;
            }

            route.Pipeline.UpdateAutoSyncState(
                (int)Math.Round(route.CurrentAutoDelayMilliseconds),
                route.CurrentAutoRateRatio,
                route.FilteredArrivalMilliseconds,
                route.Confidence,
                route.LockState,
                route.StatusText,
                _settings.MarkerLevelPercent,
                route.IsTimingMaster);
        }
    }

    private void ApplyRouteStates(bool resetToManual)
    {
        foreach (var route in _routes)
        {
            if (resetToManual)
            {
                route.Pipeline.ResetAutoSyncState();
                route.LockState = SyncLockState.Disabled;
                route.StatusText = "Manual sync only.";
                route.Confidence = 0;
                continue;
            }

            route.Pipeline.UpdateAutoSyncState(
                (int)Math.Round(route.CurrentAutoDelayMilliseconds),
                route.CurrentAutoRateRatio,
                route.FilteredArrivalMilliseconds,
                route.Confidence,
                route.LockState,
                _settings.AllowsControl ? route.StatusText : $"Monitor only. {route.StatusText}",
                _settings.MarkerLevelPercent,
                route.IsTimingMaster);
        }
    }

    private void SetRoutesWaitingForMic(string message)
    {
        if (!_roomMicWarningLogged)
        {
            _roomMicWarningLogged = true;
            _logger.Warn(message);
        }

        foreach (var route in _routes)
        {
            route.LockState = SyncLockState.WaitingForMic;
            route.StatusText = message;
            route.Pipeline.UpdateAutoSyncState(
                0,
                1.0,
                0,
                0,
                SyncLockState.WaitingForMic,
                message,
                0,
                route.IsTimingMaster);
        }
    }

    private void SetRoutesFaulted(string message)
    {
        foreach (var route in _routes)
        {
            route.LockState = SyncLockState.Faulted;
            route.StatusText = message;
            route.Pipeline.UpdateAutoSyncState(
                0,
                1.0,
                route.FilteredArrivalMilliseconds,
                0,
                SyncLockState.Faulted,
                message,
                0,
                route.IsTimingMaster);
        }
    }

    private sealed class RouteTracker
    {
        public RouteTracker(AudioOutputPipeline pipeline)
        {
            Pipeline = pipeline;
            SlotIndex = pipeline.SlotIndex;
            CurrentAutoRateRatio = 1.0;
            LockState = SyncLockState.Listening;
            StatusText = "Listening for marker.";
        }

        public AudioOutputPipeline Pipeline { get; }

        public int SlotIndex { get; }

        public bool IsTimingMaster { get; set; }

        public bool HasEstimate { get; set; }

        public double FilteredArrivalMilliseconds { get; set; }

        public double DriftEstimateMillisecondsPerSecond { get; set; }

        public double Confidence { get; set; }

        public double CurrentAutoDelayMilliseconds { get; set; }

        public double CurrentAutoRateRatio { get; set; }

        public SyncLockState LockState { get; set; }

        public string StatusText { get; set; }

        public int ConsecutiveGoodMeasurements { get; set; }

        public int ConsecutiveMisses { get; set; }

        public DateTime LastMeasurementUtc { get; set; }
    }
}
