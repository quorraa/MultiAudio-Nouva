#if false
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
    private const int LeadSilenceMilliseconds = 140;
    private const int WakeBurstMilliseconds = 28;
    private const int WakeGapMilliseconds = 220;
    private const int BurstMilliseconds = 28;
    private const int GapMilliseconds = 72;
    private const int BurstCount = 2;
    private const int TailMilliseconds = 260;
    private const int CaptureWarmupMilliseconds = 250;
    private const int PostPlaybackGapMilliseconds = 260;
    private const int CalibrationRepeatsPerRoute = 5;
    private const int SearchPaddingBeforeMilliseconds = 90;
    private const int SearchPaddingAfterMilliseconds = 950;
    private const int EnvelopeWindowMilliseconds = 5;
    private const int MinimumConfidenceWindowMilliseconds = 18;
    private const double MinimumConfidenceScore = 2.0;
    private const double RouteStabilityToleranceMilliseconds = 55;
    private const int MinimumStableSamplesPerRoute = 2;

    private readonly AppLogger _logger;
    private readonly WaveFormat _playbackFormat = WaveFormat.CreateIeeeFloatWaveFormat(InternalSampleRate, 2);
    private readonly byte[] _playbackSignalBytes;
    private readonly int _periodSamples;

    public CalibrationService(AppLogger logger)
    {
        _logger = logger;
        (_playbackSignalBytes, _periodSamples) = CreateCalibrationSignal();
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

                return (Output: output, Device: device);
            })
            .ToList();

        try
        {
            _logger.Info($"Calibration started using microphone '{inputDevice.FriendlyName}'.");
            _logger.Info("Calibration plays directly to each output with zero added app delay; current manual delay sliders are ignored during measurement.");
            var diagnosticsDirectory = CreateCalibrationDiagnosticsDirectory();
            var routeDiagnostics = new List<string>();
            var results = new List<CalibrationOutputResult>();

            foreach (var routeInfo in routeInfos)
            {
                var routeResult = await CalibrateRouteAsync(
                    inputDevice,
                    routeInfo.Output.SlotIndex,
                    routeInfo.Device,
                    diagnosticsDirectory,
                    routeDiagnostics,
                    cancellationToken);
                results.Add(routeResult);
            }
            _logger.Info($"Calibration diagnostics saved to '{diagnosticsDirectory}'.");
            SaveCalibrationSummaryDiagnostics(diagnosticsDirectory, routeInfos, routeDiagnostics, results);

            var successful = results.Where(result => result.Succeeded).ToList();
            if (successful.Count == 0)
            {
                _logger.Warn("Calibration failed to detect any bursts.");
                return new CalibrationSessionResult { Outputs = results };
            }

            var maxLatency = successful.Max(result => result.MeasuredLatencyMilliseconds);
            foreach (var result in results)
            {
                if (!result.Succeeded)
                {
                    continue;
                }

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
        List<string> routeDiagnostics,
        CancellationToken cancellationToken)
    {
        var successfulAttempts = new List<CalibrationOutputResult>();

        for (var repeatIndex = 1; repeatIndex <= CalibrationRepeatsPerRoute; repeatIndex++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _logger.Info(
                $"Calibration burst: output {slotIndex} -> '{outputDevice.FriendlyName}' " +
                $"(sample {repeatIndex}/{CalibrationRepeatsPerRoute}).");

            var capture = await CaptureCalibrationAttemptAsync(inputDevice, outputDevice, cancellationToken);
            SaveCalibrationAttemptDiagnostics(
                diagnosticsDirectory,
                slotIndex,
                repeatIndex,
                outputDevice.FriendlyName,
                capture.CaptureFormat,
                capture.CapturedRawBytes,
                capture.PlayStart);

            var capturedMono = ConvertToMono48k(capture.CapturedRawBytes, capture.CaptureFormat);
            var result = AnalyzeOutput(slotIndex, outputDevice.FriendlyName, capture.PlayStart, capturedMono);
            routeDiagnostics.Add(
                $"O{slotIndex} S{repeatIndex}: {result.Message} | Success={result.Succeeded} | " +
                $"Latency={result.MeasuredLatencyMilliseconds:F0} ms | Confidence={result.ConfidenceScore:F2}");

            if (result.Succeeded)
            {
                successfulAttempts.Add(result);
                _logger.Info(
                    $"Calibration sample O{slotIndex} S{repeatIndex}: latency={result.MeasuredLatencyMilliseconds:F0} ms, " +
                    $"confidence={result.ConfidenceScore:F2}.");
            }
            else
            {
                _logger.Warn($"Calibration sample O{slotIndex} S{repeatIndex} did not yield a stable match.");
            }
        }

        return AnalyzeOutputSeries(slotIndex, outputDevice.FriendlyName, successfulAttempts, CalibrationRepeatsPerRoute);
    }

    private async Task<CalibrationAttemptCapture> CaptureCalibrationAttemptAsync(
        MMDevice inputDevice,
        MMDevice outputDevice,
        CancellationToken cancellationToken)
    {
        var capturedBytes = new MemoryStream();
        WaveFormat? captureFormat = null;
        var captureStopTcs = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);

        using var capture = new WasapiCapture(inputDevice);
        captureFormat = capture.WaveFormat;
        capture.DataAvailable += (_, args) => capturedBytes.Write(args.Buffer, 0, args.BytesRecorded);
        capture.RecordingStopped += (_, args) =>
        {
            if (args.Exception is not null)
            {
                captureStopTcs.TrySetException(args.Exception);
                return;
            }

            captureStopTcs.TrySetResult(null);
        };

        var stopwatch = Stopwatch.StartNew();
        capture.StartRecording();
        await Task.Delay(CaptureWarmupMilliseconds, cancellationToken);
        var playStart = stopwatch.Elapsed;
        await PlayCalibrationBurstAsync(outputDevice, cancellationToken);
        await Task.Delay(PostPlaybackGapMilliseconds, cancellationToken);
        capture.StopRecording();
        await captureStopTcs.Task;

        return new CalibrationAttemptCapture(capturedBytes.ToArray(), captureFormat, playStart);
    }

    private async Task PlayCalibrationBurstAsync(MMDevice outputDevice, CancellationToken cancellationToken)
    {
        var tcs = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var player = new WasapiOut(outputDevice, AudioClientShareMode.Shared, true, 60);
        EventHandler<StoppedEventArgs>? handler = null;
        handler = (_, args) =>
        {
            if (args.Exception is not null)
            {
                tcs.TrySetException(args.Exception);
            }
            else
            {
                tcs.TrySetResult(null);
            }
        };

        player.PlaybackStopped += handler;

        try
        {
            using var signalStream = new MemoryStream(_playbackSignalBytes, writable: false);
            using var waveStream = new RawSourceWaveStream(signalStream, _playbackFormat);
            player.Init(waveStream);
            player.Play();

            using var registration = cancellationToken.Register(() => tcs.TrySetCanceled(cancellationToken));
            await tcs.Task;
        }
        finally
        {
            player.PlaybackStopped -= handler;
        }
    }

    private CalibrationOutputResult AnalyzeOutputSeries(
        int slotIndex,
        string deviceName,
        IReadOnlyList<(int SlotIndex, string DeviceName, int RepeatIndex, TimeSpan StartTime)> markers,
        float[] capturedMono)
    {
        var attempts = markers
            .Select(marker => AnalyzeOutput(slotIndex, deviceName, marker.StartTime, capturedMono))
            .Where(result => result.Succeeded)
            .OrderBy(result => result.MeasuredLatencyMilliseconds)
            .ToList();

        if (attempts.Count == 0)
        {
            return new CalibrationOutputResult
            {
                SlotIndex = slotIndex,
                DeviceName = deviceName,
                Message = "No calibration samples for this route produced a stable match."
            };
        }

        var stableCluster = SelectStableCluster(attempts);
        if (stableCluster.Count < MinimumStableSamplesPerRoute)
        {
            return new CalibrationOutputResult
            {
                SlotIndex = slotIndex,
                DeviceName = deviceName,
                Message = $"Only {attempts.Count}/{markers.Count} usable samples were found, but they did not agree closely enough to trust."
            };
        }

        var medianIndex = stableCluster.Count / 2;
        var median = stableCluster[medianIndex];
        var averagedConfidence = stableCluster.Average(result => result.ConfidenceScore);
        var spread = stableCluster.Count == 1
            ? 0
            : stableCluster.Max(result => result.MeasuredLatencyMilliseconds) - stableCluster.Min(result => result.MeasuredLatencyMilliseconds);

        return new CalibrationOutputResult
        {
            SlotIndex = slotIndex,
            DeviceName = deviceName,
            Succeeded = true,
            MeasuredLatencyMilliseconds = median.MeasuredLatencyMilliseconds,
            ConfidenceScore = averagedConfidence,
            Message = stableCluster.Count == 1
                ? $"One stable sample matched around {median.MeasuredLatencyMilliseconds:F0} ms."
                : $"Used median of {stableCluster.Count}/{markers.Count} stable samples around {median.MeasuredLatencyMilliseconds:F0} ms (spread {spread:F0} ms)."
        };
    }

    private CalibrationOutputResult AnalyzeOutput(int slotIndex, string deviceName, TimeSpan playStart, float[] capturedMono)
    {
        var predictedBurstStartMs = playStart.TotalMilliseconds
            + LeadSilenceMilliseconds
            + WakeBurstMilliseconds
            + WakeGapMilliseconds;
        var predictedStartSample = (int)Math.Round(predictedBurstStartMs * InternalSampleRate / 1000.0);
        var searchStart = Math.Max(0, predictedStartSample - MillisecondsToSamples(SearchPaddingBeforeMilliseconds));
        var searchEnd = Math.Min(
            capturedMono.Length,
            predictedStartSample + MillisecondsToSamples(SearchPaddingAfterMilliseconds));

        if (searchEnd <= searchStart)
        {
            return new CalibrationOutputResult
            {
                SlotIndex = slotIndex,
                DeviceName = deviceName,
                Message = "Not enough captured audio to analyze this output."
            };
        }

        var envelope = BuildEnvelope(capturedMono, searchStart, searchEnd);
        if (envelope.Length == 0)
        {
            return new CalibrationOutputResult
            {
                SlotIndex = slotIndex,
                DeviceName = deviceName,
                Message = "Envelope analysis returned no usable samples."
            };
        }

        var baseline = EstimateNoiseFloor(envelope);
        var match = FindBestPatternMatch(envelope, baseline);
        if (match is null)
        {
            return new CalibrationOutputResult
            {
                SlotIndex = slotIndex,
                DeviceName = deviceName,
                Message = $"Burst pattern was not detected above noise floor {baseline:F3}."
            };
        }

        var onsetSample = searchStart + match.StartOffset;
        var confidence = match.ConfidenceScore;
        if (confidence < MinimumConfidenceScore)
        {
            return new CalibrationOutputResult
            {
                SlotIndex = slotIndex,
                DeviceName = deviceName,
                Message = $"Burst pattern was too weak for a reliable suggestion (confidence {confidence:F2})."
            };
        }

        var measuredLatency = (onsetSample - predictedStartSample) * 1000.0 / InternalSampleRate;

        return new CalibrationOutputResult
        {
            SlotIndex = slotIndex,
            DeviceName = deviceName,
            Succeeded = true,
            MeasuredLatencyMilliseconds = measuredLatency,
            ConfidenceScore = confidence,
            Message = $"Detected burst around {measuredLatency:F0} ms after the expected output start."
        };
    }

    private PatternMatch? FindBestPatternMatch(IReadOnlyList<float> envelope, double noiseFloor)
    {
        var burstWindow = MillisecondsToSamples(MinimumConfidenceWindowMilliseconds);
        var gapStartOffset = burstWindow;
        var gapEndOffset = Math.Max(gapStartOffset + 1, _periodSamples - MillisecondsToSamples(10));
        var secondBurstOffset = _periodSamples;
        var requiredLength = secondBurstOffset + burstWindow;
        if (envelope.Count <= requiredLength)
        {
            return null;
        }

        var candidates = new List<PatternMatch>();
        for (var startOffset = 0; startOffset <= envelope.Count - requiredLength; startOffset++)
        {
            var firstBurstPeak = FindPeak(envelope, startOffset, burstWindow);
            var secondBurstPeak = FindPeak(envelope, startOffset + secondBurstOffset, burstWindow);
            var gapAverage = FindAverage(envelope, startOffset + gapStartOffset, gapEndOffset - gapStartOffset);
            var trailingAverage = FindAverage(envelope, startOffset + secondBurstOffset + burstWindow, burstWindow);

            var burstAverage = (firstBurstPeak + secondBurstPeak) / 2.0;
            var valleyReference = Math.Max(noiseFloor, Math.Max(gapAverage, trailingAverage));
            var confidence = burstAverage / Math.Max(0.001, valleyReference);
            var score = burstAverage - (valleyReference * 0.75);

            if (firstBurstPeak < noiseFloor * 2.2 || secondBurstPeak < noiseFloor * 2.2)
            {
                continue;
            }

            candidates.Add(new PatternMatch(startOffset, confidence, score));
        }

        if (candidates.Count == 0)
        {
            return null;
        }

        var bestScore = candidates.Max(candidate => candidate.Score);
        var viable = candidates
            .Where(candidate => candidate.Score >= bestScore * 0.86)
            .OrderBy(candidate => candidate.StartOffset)
            .ThenByDescending(candidate => candidate.ConfidenceScore)
            .ToList();

        return viable.Count == 0
            ? candidates.OrderByDescending(candidate => candidate.Score).First()
            : viable[0];
    }

    private static List<CalibrationOutputResult> SelectStableCluster(IReadOnlyList<CalibrationOutputResult> attempts)
    {
        if (attempts.Count == 0)
        {
            return [];
        }

        var ordered = attempts.OrderBy(result => result.MeasuredLatencyMilliseconds).ToList();
        List<CalibrationOutputResult> bestCluster = [ordered[0]];

        for (var start = 0; start < ordered.Count; start++)
        {
            var cluster = new List<CalibrationOutputResult> { ordered[start] };
            for (var end = start + 1; end < ordered.Count; end++)
            {
                var spread = ordered[end].MeasuredLatencyMilliseconds - cluster[0].MeasuredLatencyMilliseconds;
                if (spread > RouteStabilityToleranceMilliseconds)
                {
                    break;
                }

                cluster.Add(ordered[end]);
            }

            if (cluster.Count > bestCluster.Count)
            {
                bestCluster = cluster;
                continue;
            }

            if (cluster.Count == bestCluster.Count &&
                cluster.Average(result => result.ConfidenceScore) > bestCluster.Average(result => result.ConfidenceScore))
            {
                bestCluster = cluster;
            }
        }

        return bestCluster;
    }

    private static double FindPeak(IReadOnlyList<float> envelope, int start, int count)
    {
        if (start >= envelope.Count || count <= 0)
        {
            return 0;
        }

        var end = Math.Min(envelope.Count, start + count);
        double peak = 0;
        for (var index = start; index < end; index++)
        {
            if (envelope[index] > peak)
            {
                peak = envelope[index];
            }
        }

        return peak;
    }

    private static double FindAverage(IReadOnlyList<float> envelope, int start, int count)
    {
        if (start >= envelope.Count || count <= 0)
        {
            return 0;
        }

        var end = Math.Min(envelope.Count, start + count);
        double total = 0;
        var samples = 0;
        for (var index = start; index < end; index++)
        {
            total += envelope[index];
            samples++;
        }

        return samples == 0 ? 0 : total / samples;
    }

    private float[] BuildEnvelope(float[] samples, int start, int end)
    {
        var envelopeWindow = Math.Max(1, MillisecondsToSamples(EnvelopeWindowMilliseconds));
        var segmentLength = end - start;
        if (segmentLength <= envelopeWindow)
        {
            return [];
        }

        var envelope = new float[segmentLength];
        double rolling = 0;
        for (var index = 0; index < segmentLength; index++)
        {
            var absolute = Math.Abs(samples[start + index]);
            rolling += absolute;

            if (index >= envelopeWindow)
            {
                rolling -= Math.Abs(samples[start + index - envelopeWindow]);
            }

            envelope[index] = (float)(rolling / Math.Min(index + 1, envelopeWindow));
        }

        return envelope;
    }

    private static double EstimateNoiseFloor(IReadOnlyList<float> envelope)
    {
        if (envelope.Count == 0)
        {
            return 0.001;
        }

        var quietSampleCount = Math.Max(12, envelope.Count / 6);
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

    private static (byte[] StereoSignalBytes, int PeriodSamples) CreateCalibrationSignal()
    {
        var mono = new List<float>();
        mono.AddRange(CreateSilence(LeadSilenceMilliseconds));
        mono.AddRange(CreateWindowedNoiseBurst(WakeBurstMilliseconds));
        mono.AddRange(CreateSilence(WakeGapMilliseconds));

        for (var burstIndex = 0; burstIndex < BurstCount; burstIndex++)
        {
            mono.AddRange(CreateWindowedNoiseBurst(BurstMilliseconds));
            if (burstIndex < BurstCount - 1)
            {
                mono.AddRange(CreateSilence(GapMilliseconds));
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
        var periodSamples = MillisecondsToSamples(BurstMilliseconds + GapMilliseconds);
        return (bytes, periodSamples);
    }

    private static IEnumerable<float> CreateSilence(int milliseconds)
    {
        return Enumerable.Repeat(0f, MillisecondsToSamples(milliseconds));
    }

    private static IEnumerable<float> CreateWindowedNoiseBurst(int milliseconds)
    {
        var samples = MillisecondsToSamples(milliseconds);
        var random = new Random(17);
        for (var index = 0; index < samples; index++)
        {
            var position = index / (double)Math.Max(1, samples - 1);
            var window = 0.5 - (0.5 * Math.Cos(position * Math.PI * 2));
            var noise = ((float)random.NextDouble() * 2f) - 1f;
            yield return noise * (float)window * 0.38f;
        }
    }

    private static int MillisecondsToSamples(int milliseconds)
    {
        return (int)Math.Round(milliseconds * InternalSampleRate / 1000.0);
    }

    private static string SaveCalibrationDiagnostics(
        byte[] capturedRawBytes,
        WaveFormat captureFormat,
        IReadOnlyList<(OutputRouteConfig Output, MMDevice Device)> routeInfos,
        IReadOnlyList<(int SlotIndex, string DeviceName, int RepeatIndex, TimeSpan StartTime)> playMarkers)
    {
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MultiOutputAudioTester",
            "diagnostics",
            $"calibration-{DateTime.Now:yyyyMMdd-HHmmss}");
        Directory.CreateDirectory(root);

        var wavPath = Path.Combine(root, "capture.wav");
        using (var writer = new WaveFileWriter(wavPath, captureFormat))
        {
            writer.Write(capturedRawBytes, 0, capturedRawBytes.Length);
        }

        var markerLines = new List<string>
        {
            $"Created: {DateTime.Now:yyyy-MM-dd HH:mm:ss}",
            $"CaptureFormat: {captureFormat}",
            "Routes:"
        };

        markerLines.AddRange(routeInfos
            .OrderBy(route => route.Output.SlotIndex)
            .Select(route => $"  O{route.Output.SlotIndex}: {route.Device.FriendlyName}"));

        markerLines.Add("PlayMarkers:");
        markerLines.AddRange(playMarkers
            .OrderBy(marker => marker.StartTime)
            .Select(marker =>
                $"  O{marker.SlotIndex}, Sample={marker.RepeatIndex}, Start={marker.StartTime.TotalMilliseconds:F0} ms, Device={marker.DeviceName}"));

        File.WriteAllLines(Path.Combine(root, "markers.txt"), markerLines);
        return root;
    }

    private sealed record PatternMatch(int StartOffset, double ConfidenceScore, double Score);
}
#endif
