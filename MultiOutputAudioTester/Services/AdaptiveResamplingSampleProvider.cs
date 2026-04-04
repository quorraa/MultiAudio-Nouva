using NAudio.Wave;

namespace MultiOutputAudioTester.Services;

public sealed class AdaptiveResamplingSampleProvider : ISampleProvider
{
    private readonly ISampleProvider _source;
    private readonly int _channels;
    private readonly object _sync = new();

    private float[] _sourceBuffer = new float[32768];
    private double _readFramePosition;
    private int _bufferedSamples;
    private double _playbackRate = 1.0;

    public AdaptiveResamplingSampleProvider(ISampleProvider source)
    {
        _source = source;
        _channels = source.WaveFormat.Channels;
        WaveFormat = source.WaveFormat;
    }

    public WaveFormat WaveFormat { get; }

    public double PlaybackRate
    {
        get
        {
            lock (_sync)
            {
                return _playbackRate;
            }
        }
        set
        {
            lock (_sync)
            {
                _playbackRate = Math.Clamp(value, 0.995, 1.005);
            }
        }
    }

    public int Read(float[] buffer, int offset, int count)
    {
        var requestedFrames = count / _channels;
        if (requestedFrames <= 0)
        {
            return 0;
        }

        lock (_sync)
        {
            var estimatedRequiredFrames = (int)Math.Ceiling(_readFramePosition + (requestedFrames * _playbackRate) + 3);
            EnsureFramesAvailable(estimatedRequiredFrames);

            for (var frame = 0; frame < requestedFrames; frame++)
            {
                var baseFrame = (int)_readFramePosition;
                var fraction = _readFramePosition - baseFrame;
                var nextFrame = Math.Min(baseFrame + 1, Math.Max(baseFrame, (_bufferedSamples / _channels) - 1));

                for (var channel = 0; channel < _channels; channel++)
                {
                    var sourceIndex = (baseFrame * _channels) + channel;
                    var nextIndex = (nextFrame * _channels) + channel;
                    var currentSample = sourceIndex < _bufferedSamples ? _sourceBuffer[sourceIndex] : 0f;
                    var nextSample = nextIndex < _bufferedSamples ? _sourceBuffer[nextIndex] : currentSample;
                    buffer[offset + (frame * _channels) + channel] =
                        currentSample + ((nextSample - currentSample) * (float)fraction);
                }

                _readFramePosition += _playbackRate;
            }

            TrimConsumedFrames();
        }

        return requestedFrames * _channels;
    }

    private void EnsureFramesAvailable(int requiredFrames)
    {
        var requiredSamples = requiredFrames * _channels;
        while (_bufferedSamples < requiredSamples)
        {
            EnsureCapacity(requiredSamples + 4096);
            var read = _source.Read(_sourceBuffer, _bufferedSamples, _sourceBuffer.Length - _bufferedSamples);
            if (read <= 0)
            {
                break;
            }

            _bufferedSamples += read;
        }
    }

    private void EnsureCapacity(int requiredSamples)
    {
        if (_sourceBuffer.Length >= requiredSamples)
        {
            return;
        }

        var newSize = _sourceBuffer.Length;
        while (newSize < requiredSamples)
        {
            newSize *= 2;
        }

        Array.Resize(ref _sourceBuffer, newSize);
    }

    private void TrimConsumedFrames()
    {
        var framesToDiscard = Math.Max(0, (int)_readFramePosition - 1);
        if (framesToDiscard <= 0)
        {
            return;
        }

        var samplesToDiscard = framesToDiscard * _channels;
        if (samplesToDiscard >= _bufferedSamples)
        {
            _bufferedSamples = 0;
            _readFramePosition = 0;
            return;
        }

        var remainingSamples = _bufferedSamples - samplesToDiscard;
        for (var index = 0; index < remainingSamples; index++)
        {
            _sourceBuffer[index] = _sourceBuffer[samplesToDiscard + index];
        }

        _bufferedSamples -= samplesToDiscard;
        _readFramePosition -= framesToDiscard;
    }
}
