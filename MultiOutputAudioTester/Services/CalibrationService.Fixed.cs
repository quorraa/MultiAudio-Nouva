using System.Diagnostics;
using System.IO;
using MultiOutputAudioTester.Models;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace MultiOutputAudioTester.Services;

public sealed class CalibrationService
{
    private const int InternalSampleRate = 48000;
    private const int CaptureWarmupMilliseconds = 180;
    private const int SilentWarmupMilliseconds = 180;
    private const int WakeBurstMilliseconds = 42;
    private const int WakeGapMilliseconds = 320;
    private const int MeasuredBurstMilliseconds = 24;
    private const int MeasuredGapMilliseconds = 78;
    private const int MeasuredBurstCount = 2;
    private const int TailMilliseconds = 320;
    private const int PostPlaybackGapMilliseconds = 420;
    private const int CalibrationRepeatsPerRoute = 5;
    private const int SearchPaddingBeforeMilliseconds = 20;
    private const int SearchPaddingAfterMilliseconds = 950;
    private const double MinimumConfidenceScore = 5.0;
    private const int BurstTimingToleranceMilliseconds = 28;
    private const int MaximumAcceptedTimingErrorMilliseconds = 28;
    private const double MinimumAcceptedMatchScore = 0.05;
    private const double RouteStabilityToleranceMilliseconds = 55;
    private const int MinimumStableSamplesPerRoute = 2;

    private readonly AppLogger _logger;
    private readonly WaveFormat _playbackFormat = WaveFormat.CreateIeeeFloatWaveFormat(InternalSampleRate, 2);
    private readonly CalibrationSignalDefinition _signal;
    private readonly int _samplesPerMillisecond = InternalSampleRate / 1000;

    public CalibrationService(AppLogger logger)
    {
        _logger = logger;
        _signal = CreateCalibrationSignal();
    }

    public async Task<CalibrationSessionResult> RunCalibrationAsync(
        string calibrationInputDeviceId,
        IReadOnlyList<OutputRouteConfig> outputs,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(calibrationInputDeviceId))
        {
            throw new InvalidOperationException("Select a calibration microphone before running calibration.");
        }

        using var enumerator = new MMDeviceEnumerator();
        using var inputDevice = enumerator.GetDevice(calibrationInputDeviceId);
        if (inputDevice.State != DeviceState.Active)
        {
            throw new InvalidOperationException($"Calibration input '{inputDevice.FriendlyName}' is not active.");
        }

        var routeInfos = outputs.OrderBy(output => output.SlotIndex)
            .Select(output =>
            {
                if (string.IsNullOrWhiteSpace(output.DeviceId))
                {
                    throw new InvalidOperationException($"Output {output.SlotIndex} does not have a selected device.");
                }

                var device = enumerator.GetDevice(output.DeviceId);
                if (device.State != DeviceState.Active)
                {
                    device.Dispose();
                    throw new InvalidOperationException($"Output device '{output.DeviceId}' is not active.");
                }

                return new CalibrationRouteInfo(output, device);
            })
            .ToList();

        try
        {
            _logger.Info($"Calibration started using microphone '{inputDevice.FriendlyName}'.");
            _logger.Info("Calibration plays directly to each output with zero added app delay; current manual delay sliders are ignored during measurement.");

            var diagnosticsDirectory = CreateCalibrationDiagnosticsDirectory();
            var attemptDiagnostics = new List<string>();
            var results = new List<CalibrationOutputResult>();

            foreach (var routeInfo in routeInfos)
            {
                var routeResult = await CalibrateRouteAsync(
                    inputDevice,
                    routeInfo.Output.SlotIndex,
                    routeInfo.Device,
                    diagnosticsDirectory,
                    attemptDiagnostics,
                    cancellationToken);
                results.Add(routeResult);
            }

            SaveCalibrationSummaryDiagnostics(diagnosticsDirectory, inputDevice.FriendlyName, routeInfos, attemptDiagnostics, results);
            _logger.Info($"Calibration diagnostics saved to '{diagnosticsDirectory}'.");

            var successful = results.Where(result => result.Succeeded).ToList();
            if (successful.Count == 0)
            {
                _logger.Warn("Calibration failed to detect any stable arrival clusters.");
                return new CalibrationSessionResult { Outputs = results };
            }

            var maxLatency = successful.Max(result => result.MeasuredLatencyMilliseconds);
            foreach (var result in successful)
            {
                result.SuggestedDelayMilliseconds = (int)Math.Round(maxLatency - result.MeasuredLatencyMilliseconds);
                _logger.Info(
                    $"Calibration result O{result.SlotIndex}: latency={result.MeasuredLatencyMilliseconds:F0} ms, " +
                    $"suggested delay={result.SuggestedDelayMilliseconds} ms, confidence={result.ConfidenceScore:F2}.");
            }

            return new CalibrationSessionResult { Outputs = results };
        }
        finally
        {
            foreach (var routeInfo in routeInfos)
            {
                routeInfo.Device.Dispose();
            }
        }
    }

    private async Task<CalibrationOutputResult> CalibrateRouteAsync(
        MMDevice inputDevice,
        int slotIndex,
        MMDevice outputDevice,
        string diagnosticsDirectory,
        List<string> attemptDiagnostics,
        CancellationToken cancellationToken)
    {
        var successfulAttempts = new List<CalibrationAttemptAnalysis>();
        var deviceName = outputDevice.FriendlyName;

        for (var repeatIndex = 1; repeatIndex <= CalibrationRepeatsPerRoute; repeatIndex++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _logger.Info(
                $"Calibration burst: output {slotIndex} -> '{deviceName}' " +
                $"(sample {repeatIndex}/{CalibrationRepeatsPerRoute}).");

            var capture = await CaptureCalibrationAttemptAsync(inputDevice, outputDevice, cancellationToken);
            var capturedMono = ConvertToMono48k(capture.CapturedRawBytes, capture.CaptureFormat);
            var analysis = AnalyzeAttempt(slotIndex, deviceName, repeatIndex, capture.PlayStart, capturedMono);

            SaveCalibrationAttemptDiagnostics(
                diagnosticsDirectory,
                slotIndex,
                repeatIndex,
                deviceName,
                capture,
                analysis);

            attemptDiagnostics.Add(
                $"O{slotIndex} S{repeatIndex}: Success={analysis.Succeeded} | " +
                $"Latency={analysis.MeasuredLatencyMilliseconds:F0} ms | Confidence={analysis.ConfidenceScore:F2} | {analysis.Message}");

            if (analysis.Succeeded)
            {
                successfulAttempts.Add(analysis);
                _logger.Info(
                    $"Calibration sample O{slotIndex} S{repeatIndex}: latency={analysis.MeasuredLatencyMilliseconds:F0} ms, " +
                    $"confidence={analysis.ConfidenceScore:F2}.");
            }
            else
            {
                _logger.Warn($"Calibration sample O{slotIndex} S{repeatIndex} failed: {analysis.Message}");
            }
        }

        var routeResult = BuildRouteResult(slotIndex, deviceName, successfulAttempts);
        if (!routeResult.Succeeded)
        {
            _logger.Warn($"Calibration route O{slotIndex} did not produce a stable result. {routeResult.Message}");
        }

        return routeResult;
    }

    private async Task<CalibrationAttemptCapture> CaptureCalibrationAttemptAsync(
        MMDevice inputDevice,
        MMDevice outputDevice,
        CancellationToken cancellationToken)
    {
        using var capturedBytes = new MemoryStream();
        using var capture = new WasapiCapture(inputDevice);
        var stopTcs = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);

        capture.DataAvailable += (_, args) => capturedBytes.Write(args.Buffer, 0, args.BytesRecorded);
        capture.RecordingStopped += (_, args) =>
        {
            if (args.Exception is not null)
            {
                stopTcs.TrySetException(args.Exception);
                return;
            }

            stopTcs.TrySetResult(null);
        };

        var stopwatch = Stopwatch.StartNew();
        capture.StartRecording();
        await Task.Delay(CaptureWarmupMilliseconds, cancellationToken);

        var playStart = stopwatch.Elapsed;
        await PlayCalibrationSignalAsync(outputDevice, cancellationToken);

        await Task.Delay(PostPlaybackGapMilliseconds, cancellationToken);
        capture.StopRecording();
        await stopTcs.Task;

        return new CalibrationAttemptCapture(capturedBytes.ToArray(), capture.WaveFormat, playStart);
    }

    private async Task PlayCalibrationSignalAsync(MMDevice outputDevice, CancellationToken cancellationToken)
    {
        using var player = new WasapiOut(outputDevice, AudioClientShareMode.Shared, true, 60);
        var stopTcs = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);

        EventHandler<StoppedEventArgs>? handler = null;
        handler = (_, args) =>
        {
            if (args.Exception is not null)
            {
                stopTcs.TrySetException(args.Exception);
                return;
            }

            stopTcs.TrySetResult(null);
        };

        player.PlaybackStopped += handler;

        try
        {
            using var signalStream = new MemoryStream(_signal.StereoSignalBytes, writable: false);
            using var waveStream = new RawSourceWaveStream(signalStream, _playbackFormat);
            player.Init(waveStream);
            player.Play();

            using var registration = cancellationToken.Register(() => stopTcs.TrySetCanceled(cancellationToken));
            await stopTcs.Task;
        }
        finally
        {
            player.PlaybackStopped -= handler;
        }
    }

    private CalibrationAttemptAnalysis AnalyzeAttempt(
        int slotIndex,
        string deviceName,
        int repeatIndex,
        TimeSpan playStart,
        float[] capturedMono)
    {
        if (capturedMono.Length == 0)
        {
            return new CalibrationAttemptAnalysis(
                slotIndex,
                deviceName,
                repeatIndex,
                false,
                0,
                0,
                "No captured microphone audio was available for this attempt.");
        }

        var envelope = BuildMillisecondEnvelope(capturedMono);
        if (envelope.Length <= _signal.PatternLengthMilliseconds)
        {
            return new CalibrationAttemptAnalysis(
                slotIndex,
                deviceName,
                repeatIndex,
                false,
                0,
                0,
                "Captured attempt was too short for pattern analysis.");
        }

        var predictedFirstMeasuredMilliseconds = (int)Math.Round(playStart.TotalMilliseconds) + _signal.MeasuredPatternStartMilliseconds;
        var match = FindBestAttemptMatch(envelope, predictedFirstMeasuredMilliseconds);
        if (match is null)
        {
            return new CalibrationAttemptAnalysis(
                slotIndex,
                deviceName,
                repeatIndex,
                false,
                0,
                0,
                "No stable measured-burst pair matched the expected timing window.");
        }

        var measuredLatencyMilliseconds = match.FirstMeasuredMilliseconds - predictedFirstMeasuredMilliseconds;
        return new CalibrationAttemptAnalysis(
            slotIndex,
            deviceName,
            repeatIndex,
            true,
            measuredLatencyMilliseconds,
            match.ConfidenceScore,
            $"Matched wake/doublet at {measuredLatencyMilliseconds:F0} ms relative to expected measured start " +
            $"(timing error {match.TimingErrorMilliseconds:F0} ms, contrast={match.Contrast:F2}).",
            predictedFirstMeasuredMilliseconds,
            match.FirstMeasuredMilliseconds,
            0,
            match.Contrast,
            match.Score,
            match.NoiseFloor);
    }

    private CalibrationOutputResult BuildRouteResult(
        int slotIndex,
        string deviceName,
        IReadOnlyList<CalibrationAttemptAnalysis> successfulAttempts)
    {
        if (successfulAttempts.Count == 0)
        {
            return new CalibrationOutputResult
            {
                SlotIndex = slotIndex,
                DeviceName = deviceName,
                Message = "No calibration attempts produced a usable two-burst match."
            };
        }

        var stableCluster = SelectStableCluster(successfulAttempts);
        if (stableCluster.Count < MinimumStableSamplesPerRoute)
        {
            return new CalibrationOutputResult
            {
                SlotIndex = slotIndex,
                DeviceName = deviceName,
                Message = $"Only {successfulAttempts.Count}/{CalibrationRepeatsPerRoute} attempts matched, but they did not agree closely enough to trust."
            };
        }

        var orderedCluster = stableCluster.OrderBy(result => result.MeasuredLatencyMilliseconds).ToList();
        var median = orderedCluster[orderedCluster.Count / 2];
        var spread = orderedCluster[^1].MeasuredLatencyMilliseconds - orderedCluster[0].MeasuredLatencyMilliseconds;

        return new CalibrationOutputResult
        {
            SlotIndex = slotIndex,
            DeviceName = deviceName,
            Succeeded = true,
            MeasuredLatencyMilliseconds = median.MeasuredLatencyMilliseconds,
            ConfidenceScore = orderedCluster.Average(result => result.ConfidenceScore),
            Message = orderedCluster.Count == 1
                ? $"One stable attempt matched around {median.MeasuredLatencyMilliseconds:F0} ms."
                : $"Used {orderedCluster.Count}/{CalibrationRepeatsPerRoute} agreeing attempts around {median.MeasuredLatencyMilliseconds:F0} ms (spread {spread:F0} ms)."
        };
    }

    private CalibrationMatch? FindBestAttemptMatch(float[] envelope, int predictedFirstMeasuredMilliseconds)
    {
        var searchStart = Math.Max(0, predictedFirstMeasuredMilliseconds);
        var searchEnd = Math.Min(envelope.Length - 1, predictedFirstMeasuredMilliseconds + SearchPaddingAfterMilliseconds);

        if (searchEnd <= searchStart)
        {
            return null;
        }

        var searchSlice = envelope.Skip(searchStart).Take((searchEnd - searchStart) + 1).ToArray();
        var noiseFloor = EstimateNoiseFloor(searchSlice);
        var peaks = ExtractPeakEvents(envelope, searchStart, searchEnd, noiseFloor);
        CalibrationMatch? best = null;

        foreach (var firstPeak in peaks)
        {
            if (firstPeak.Index < predictedFirstMeasuredMilliseconds - 30)
            {
                continue;
            }

            foreach (var secondPeak in peaks)
            {
                if (secondPeak.Index <= firstPeak.Index)
                {
                    continue;
                }

                var spacingError = Math.Abs((secondPeak.Index - firstPeak.Index) - _signal.MeasuredBurstSpacingMilliseconds);
                if (spacingError > BurstTimingToleranceMilliseconds)
                {
                    continue;
                }

                var measuredOffsetError = Math.Abs(firstPeak.Index - predictedFirstMeasuredMilliseconds);
                var timingError = spacingError;
                var averagePeak = (firstPeak.Value + secondPeak.Value) / 2.0;
                var confidence = averagePeak / Math.Max(0.001, noiseFloor);
                var score = (averagePeak * 4.0)
                    - (measuredOffsetError / 180.0)
                    - (timingError / 18.0);

                if (firstPeak.Value < noiseFloor * 2.0 || secondPeak.Value < noiseFloor * 2.0)
                {
                    continue;
                }

                if (confidence < MinimumConfidenceScore)
                {
                    continue;
                }

                if (measuredOffsetError > SearchPaddingAfterMilliseconds ||
                    timingError > MaximumAcceptedTimingErrorMilliseconds ||
                    score < MinimumAcceptedMatchScore)
                {
                    continue;
                }

                var candidate = new CalibrationMatch(
                    firstPeak.Index - _signal.WakeToFirstMeasuredOffsetMilliseconds,
                    firstPeak.Index,
                    secondPeak.Index,
                    confidence,
                    confidence,
                    score,
                    noiseFloor,
                    timingError);

                if (best is null ||
                    candidate.Score > best.Score + 0.02 ||
                    (Math.Abs(candidate.Score - best.Score) <= 0.02 &&
                     Math.Abs(candidate.FirstMeasuredMilliseconds - predictedFirstMeasuredMilliseconds) <
                     Math.Abs(best.FirstMeasuredMilliseconds - predictedFirstMeasuredMilliseconds)))
                {
                    best = candidate;
                }
            }
        }

        return best;
    }

    private static List<CalibrationAttemptAnalysis> SelectStableCluster(IReadOnlyList<CalibrationAttemptAnalysis> attempts)
    {
        if (attempts.Count == 0)
        {
            return [];
        }

        var ordered = attempts.OrderBy(result => result.MeasuredLatencyMilliseconds).ToList();
        List<CalibrationAttemptAnalysis> bestCluster = [ordered[0]];

        for (var start = 0; start < ordered.Count; start++)
        {
            var cluster = new List<CalibrationAttemptAnalysis> { ordered[start] };
            for (var index = start + 1; index < ordered.Count; index++)
            {
                var spread = ordered[index].MeasuredLatencyMilliseconds - cluster[0].MeasuredLatencyMilliseconds;
                if (spread > RouteStabilityToleranceMilliseconds)
                {
                    break;
                }

                cluster.Add(ordered[index]);
            }

            if (cluster.Count > bestCluster.Count)
            {
                bestCluster = cluster;
                continue;
            }

            if (cluster.Count == bestCluster.Count)
            {
                var clusterConfidence = cluster.Average(item => item.ConfidenceScore);
                var bestConfidence = bestCluster.Average(item => item.ConfidenceScore);
                if (clusterConfidence > bestConfidence)
                {
                    bestCluster = cluster;
                }
            }
        }

        return bestCluster;
    }

    private float[] BuildMillisecondEnvelope(float[] samples)
    {
        if (samples.Length == 0)
        {
            return [];
        }

        var frameCount = (int)Math.Ceiling(samples.Length / (double)_samplesPerMillisecond);
        var envelope = new float[frameCount];

        for (var frame = 0; frame < frameCount; frame++)
        {
            var start = frame * _samplesPerMillisecond;
            var end = Math.Min(samples.Length, start + _samplesPerMillisecond);
            double sumSquares = 0;
            for (var index = start; index < end; index++)
            {
                var sample = samples[index];
                sumSquares += sample * sample;
            }

            var count = Math.Max(1, end - start);
            envelope[frame] = (float)Math.Sqrt(sumSquares / count);
        }

        return SmoothEnvelope(envelope, 4);
    }

    private static float[] SmoothEnvelope(float[] envelope, int windowMilliseconds)
    {
        if (envelope.Length == 0 || windowMilliseconds <= 1)
        {
            return envelope;
        }

        var smoothed = new float[envelope.Length];
        double rolling = 0;
        for (var index = 0; index < envelope.Length; index++)
        {
            rolling += envelope[index];
            if (index >= windowMilliseconds)
            {
                rolling -= envelope[index - windowMilliseconds];
            }

            smoothed[index] = (float)(rolling / Math.Min(index + 1, windowMilliseconds));
        }

        return smoothed;
    }

    private static double ComputeNormalizedCorrelation(
        IReadOnlyList<float> envelope,
        int start,
        IReadOnlyList<float> template,
        double templateMean,
        double templateEnergy)
    {
        if (start < 0 || start + template.Count > envelope.Count)
        {
            return -1;
        }

        double segmentTotal = 0;
        for (var index = 0; index < template.Count; index++)
        {
            segmentTotal += envelope[start + index];
        }

        var segmentMean = segmentTotal / template.Count;
        double dot = 0;
        double segmentEnergy = 0;

        for (var index = 0; index < template.Count; index++)
        {
            var segmentCentered = envelope[start + index] - segmentMean;
            var templateCentered = template[index] - templateMean;
            dot += segmentCentered * templateCentered;
            segmentEnergy += segmentCentered * segmentCentered;
        }

        if (segmentEnergy <= 0.000001 || templateEnergy <= 0.000001)
        {
            return -1;
        }

        return dot / Math.Sqrt(segmentEnergy * templateEnergy);
    }

    private static double FindPeak(IReadOnlyList<float> samples, int start, int count)
    {
        if (start >= samples.Count || count <= 0)
        {
            return 0;
        }

        var end = Math.Min(samples.Count, start + count);
        double peak = 0;
        for (var index = start; index < end; index++)
        {
            if (samples[index] > peak)
            {
                peak = samples[index];
            }
        }

        return peak;
    }

    private static int FindPeakIndex(IReadOnlyList<float> samples, int start, int count)
    {
        if (start >= samples.Count || count <= 0)
        {
            return -1;
        }

        var end = Math.Min(samples.Count, start + count);
        var bestIndex = -1;
        double peak = 0;
        for (var index = start; index < end; index++)
        {
            if (samples[index] > peak)
            {
                peak = samples[index];
                bestIndex = index;
            }
        }

        return bestIndex;
    }

    private static List<PeakEvent> ExtractPeakEvents(IReadOnlyList<float> samples, int start, int end, double noiseFloor)
    {
        var peaks = new List<PeakEvent>();
        if (end - start < 3)
        {
            return peaks;
        }

        var minimumPeak = noiseFloor * 1.45;
        for (var index = Math.Max(start + 1, 1); index < Math.Min(end - 1, samples.Count - 1); index++)
        {
            var current = samples[index];
            if (current < minimumPeak)
            {
                continue;
            }

            if (current < samples[index - 1] || current < samples[index + 1])
            {
                continue;
            }

            peaks.Add(new PeakEvent(index, current));
        }

        if (peaks.Count == 0)
        {
            return peaks;
        }

        peaks = peaks.OrderByDescending(peak => peak.Value).ToList();
        var filtered = new List<PeakEvent>();
        foreach (var peak in peaks)
        {
            if (filtered.All(existing => Math.Abs(existing.Index - peak.Index) >= 18))
            {
                filtered.Add(peak);
            }

            if (filtered.Count >= 12)
            {
                break;
            }
        }

        return filtered.OrderBy(peak => peak.Index).ToList();
    }


    private static double FindAverage(IReadOnlyList<float> samples, int start, int count)
    {
        if (start >= samples.Count || count <= 0)
        {
            return 0;
        }

        var end = Math.Min(samples.Count, start + count);
        double total = 0;
        var sampleCount = 0;
        for (var index = start; index < end; index++)
        {
            total += samples[index];
            sampleCount++;
        }

        return sampleCount == 0 ? 0 : total / sampleCount;
    }

    private static double EstimateNoiseFloor(IReadOnlyList<float> envelope)
    {
        if (envelope.Count == 0)
        {
            return 0.001;
        }

        var quietSampleCount = Math.Max(12, envelope.Count / 5);
        var quietest = envelope.OrderBy(sample => sample).Take(quietSampleCount).ToList();
        return Math.Max(0.001, quietest.Average());
    }

    private static float[] ConvertToMono48k(byte[] recordedBytes, WaveFormat sourceFormat)
    {
        using var memoryStream = new MemoryStream(recordedBytes);
        using var rawStream = new RawSourceWaveStream(memoryStream, sourceFormat);

        ISampleProvider sampleProvider = rawStream.ToSampleProvider();
        sampleProvider = sampleProvider.WaveFormat.Channels switch
        {
            1 => sampleProvider,
            2 => new StereoToMonoSampleProvider(sampleProvider),
            _ => new StereoToMonoSampleProvider(new ChannelMapSampleProvider(sampleProvider))
        };

        if (sampleProvider.WaveFormat.SampleRate != InternalSampleRate)
        {
            sampleProvider = new WdlResamplingSampleProvider(sampleProvider, InternalSampleRate);
        }

        var samples = new List<float>();
        var buffer = new float[InternalSampleRate];
        while (true)
        {
            var read = sampleProvider.Read(buffer, 0, buffer.Length);
            if (read <= 0)
            {
                break;
            }

            samples.AddRange(buffer.Take(read));
        }

        return samples.ToArray();
    }

    private CalibrationSignalDefinition CreateCalibrationSignal()
    {
        var mono = new List<float>();
        mono.AddRange(CreateSilence(SilentWarmupMilliseconds));
        mono.AddRange(CreateWindowedNoiseBurst(WakeBurstMilliseconds, 0.28f, 7));
        mono.AddRange(CreateSilence(WakeGapMilliseconds));

        var measuredStartMilliseconds = SilentWarmupMilliseconds + WakeBurstMilliseconds + WakeGapMilliseconds;
        for (var burstIndex = 0; burstIndex < MeasuredBurstCount; burstIndex++)
        {
            mono.AddRange(CreateWindowedNoiseBurst(MeasuredBurstMilliseconds, 0.48f, 17));
            if (burstIndex < MeasuredBurstCount - 1)
            {
                mono.AddRange(CreateSilence(MeasuredGapMilliseconds));
            }
        }

        mono.AddRange(CreateSilence(TailMilliseconds));

        var stereo = new float[mono.Count * 2];
        for (var index = 0; index < mono.Count; index++)
        {
            stereo[index * 2] = mono[index];
            stereo[(index * 2) + 1] = mono[index];
        }

        var bytes = new byte[stereo.Length * sizeof(float)];
        Buffer.BlockCopy(stereo, 0, bytes, 0, bytes.Length);

        var measuredPatternSamples = MillisecondsToSamples((MeasuredBurstMilliseconds * MeasuredBurstCount) + MeasuredGapMilliseconds);
        var measuredMono = mono.Skip(MillisecondsToSamples(measuredStartMilliseconds)).Take(measuredPatternSamples).ToArray();
        var templateEnvelope = BuildMillisecondEnvelope(measuredMono);
        var templateMean = templateEnvelope.Average();

        double templateEnergy = 0;
        foreach (var sample in templateEnvelope)
        {
            var centered = sample - templateMean;
            templateEnergy += centered * centered;
        }

        return new CalibrationSignalDefinition(
            bytes,
            SilentWarmupMilliseconds,
            measuredStartMilliseconds,
            WakeBurstMilliseconds,
            MeasuredBurstMilliseconds,
            MeasuredGapMilliseconds,
            templateEnvelope.Length);
    }

    private IEnumerable<float> CreateSilence(int milliseconds)
    {
        return Enumerable.Repeat(0f, MillisecondsToSamples(milliseconds));
    }

    private static IEnumerable<float> CreateWindowedNoiseBurst(int milliseconds, float gain, int seed)
    {
        var samples = MillisecondsToSamples(milliseconds);
        var random = new Random(seed);
        for (var index = 0; index < samples; index++)
        {
            var position = index / (double)Math.Max(1, samples - 1);
            var window = 0.5 - (0.5 * Math.Cos(position * Math.PI * 2));
            var noise = ((float)random.NextDouble() * 2f) - 1f;
            yield return noise * (float)window * gain;
        }
    }

    private static int MillisecondsToSamples(int milliseconds)
    {
        return (int)Math.Round(milliseconds * InternalSampleRate / 1000.0);
    }

    private static string CreateCalibrationDiagnosticsDirectory()
    {
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MultiOutputAudioTester",
            "diagnostics",
            $"calibration-{DateTime.Now:yyyyMMdd-HHmmss}");
        Directory.CreateDirectory(root);
        return root;
    }

    private static void SaveCalibrationAttemptDiagnostics(
        string diagnosticsDirectory,
        int slotIndex,
        int repeatIndex,
        string deviceName,
        CalibrationAttemptCapture capture,
        CalibrationAttemptAnalysis analysis)
    {
        var prefix = $"O{slotIndex}-S{repeatIndex}";
        var wavPath = Path.Combine(diagnosticsDirectory, $"{prefix}-capture.wav");
        using (var writer = new WaveFileWriter(wavPath, capture.CaptureFormat))
        {
            writer.Write(capture.CapturedRawBytes, 0, capture.CapturedRawBytes.Length);
        }

        var lines = new List<string>
        {
            $"Created: {DateTime.Now:yyyy-MM-dd HH:mm:ss}",
            $"Route: O{slotIndex}",
            $"Sample: {repeatIndex}",
            $"Device: {deviceName}",
            $"CaptureFormat: {capture.CaptureFormat}",
            $"PlayStart: {capture.PlayStart.TotalMilliseconds:F0} ms",
            $"Succeeded: {analysis.Succeeded}",
            $"PredictedStart: {(analysis.PredictedStartMilliseconds?.ToString("F0") ?? "n/a")} ms",
            $"DetectedStart: {(analysis.DetectedStartMilliseconds?.ToString("F0") ?? "n/a")} ms",
            $"Latency: {analysis.MeasuredLatencyMilliseconds:F0} ms",
            $"Confidence: {analysis.ConfidenceScore:F2}",
            $"Correlation: {analysis.Correlation:F2}",
            $"Contrast: {analysis.Contrast:F2}",
            $"NoiseFloor: {analysis.NoiseFloor:F3}",
            $"Score: {analysis.Score:F2}",
            $"Message: {analysis.Message}"
        };

        File.WriteAllLines(Path.Combine(diagnosticsDirectory, $"{prefix}.txt"), lines);
    }

    private static void SaveCalibrationSummaryDiagnostics(
        string diagnosticsDirectory,
        string inputDeviceName,
        IReadOnlyList<CalibrationRouteInfo> routeInfos,
        IReadOnlyList<string> attemptDiagnostics,
        IReadOnlyList<CalibrationOutputResult> results)
    {
        var markerLines = new List<string>
        {
            $"Created: {DateTime.Now:yyyy-MM-dd HH:mm:ss}",
            $"CalibrationInput: {inputDeviceName}",
            "Routes:"
        };

        markerLines.AddRange(routeInfos
            .OrderBy(route => route.Output.SlotIndex)
            .Select(route => $"  O{route.Output.SlotIndex}: {route.Device.FriendlyName}"));

        markerLines.Add("AttemptFiles:");
        foreach (var route in routeInfos.OrderBy(route => route.Output.SlotIndex))
        {
            for (var sample = 1; sample <= CalibrationRepeatsPerRoute; sample++)
            {
                markerLines.Add($"  O{route.Output.SlotIndex}, Sample={sample}, File=O{route.Output.SlotIndex}-S{sample}-capture.wav");
            }
        }

        File.WriteAllLines(Path.Combine(diagnosticsDirectory, "markers.txt"), markerLines);

        var summaryLines = new List<string>
        {
            "Calibration Attempt Diagnostics:"
        };
        summaryLines.AddRange(attemptDiagnostics);
        summaryLines.Add(string.Empty);
        summaryLines.Add("Route Results:");

        summaryLines.AddRange(results.OrderBy(result => result.SlotIndex)
            .Select(result =>
                $"O{result.SlotIndex}: Success={result.Succeeded} | Latency={result.MeasuredLatencyMilliseconds:F0} ms | " +
                $"SuggestedDelay={result.SuggestedDelayMilliseconds} ms | Confidence={result.ConfidenceScore:F2} | {result.Message}"));

        File.WriteAllLines(Path.Combine(diagnosticsDirectory, "summary.txt"), summaryLines);
    }

    private sealed record CalibrationSignalDefinition(
        byte[] StereoSignalBytes,
        int WakeStartMilliseconds,
        int MeasuredPatternStartMilliseconds,
        int WakeWindowMilliseconds,
        int BurstWindowMilliseconds,
        int GapWindowMilliseconds,
        int PatternLengthMilliseconds)
    {
        public int WakeToFirstMeasuredOffsetMilliseconds => MeasuredPatternStartMilliseconds - WakeStartMilliseconds;

        public int WakeToSecondMeasuredOffsetMilliseconds => WakeToFirstMeasuredOffsetMilliseconds + BurstWindowMilliseconds + GapWindowMilliseconds;

        public int MeasuredBurstSpacingMilliseconds => BurstWindowMilliseconds + GapWindowMilliseconds;
    }

    private sealed record CalibrationRouteInfo(OutputRouteConfig Output, MMDevice Device);

    private sealed record CalibrationAttemptCapture(byte[] CapturedRawBytes, WaveFormat CaptureFormat, TimeSpan PlayStart);

    private sealed record CalibrationAttemptAnalysis(
        int SlotIndex,
        string DeviceName,
        int RepeatIndex,
        bool Succeeded,
        double MeasuredLatencyMilliseconds,
        double ConfidenceScore,
        string Message,
        int? PredictedStartMilliseconds = null,
        int? DetectedStartMilliseconds = null,
        double Correlation = 0,
        double Contrast = 0,
        double Score = 0,
        double NoiseFloor = 0);

    private sealed record CalibrationMatch(
        int WakeStartMilliseconds,
        int FirstMeasuredMilliseconds,
        int SecondMeasuredMilliseconds,
        double ConfidenceScore,
        double Contrast,
        double Score,
        double NoiseFloor,
        int TimingErrorMilliseconds);

    private sealed record PeakEvent(int Index, double Value);
}
