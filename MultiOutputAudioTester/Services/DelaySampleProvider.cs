using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace MultiOutputAudioTester.Services;

public sealed class DelaySampleProvider : ISampleProvider
{
    private readonly ISampleProvider _source;
    private readonly int _channels;
    private readonly int _capacityFrames;
    private readonly float[] _history;
    private readonly object _sync = new();

    private int _delayFrames;
    private int _writeFrameIndex;
    private long _framesWritten;

    public DelaySampleProvider(ISampleProvider source, int maxDelayMilliseconds = 2000)
    {
        _source = source;
        _channels = source.WaveFormat.Channels;
        _capacityFrames = (source.WaveFormat.SampleRate * maxDelayMilliseconds / 1000) + 2;
        _history = new float[_capacityFrames * _channels];
        WaveFormat = source.WaveFormat;
    }

    public WaveFormat WaveFormat { get; }

    public int DelayMilliseconds
    {
        get
        {
            lock (_sync)
            {
                return _delayFrames * 1000 / WaveFormat.SampleRate;
            }
        }
        set
        {
            lock (_sync)
            {
                _delayFrames = Math.Clamp(value, 0, 2000) * WaveFormat.SampleRate / 1000;
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

        var sourceBuffer = new float[requestedFrames * _channels];
        var sourceSamplesRead = _source.Read(sourceBuffer, 0, sourceBuffer.Length);
        var sourceFramesRead = sourceSamplesRead / _channels;

        for (var frame = 0; frame < requestedFrames; frame++)
        {
            for (var channel = 0; channel < _channels; channel++)
            {
                var sample = frame < sourceFramesRead
                    ? sourceBuffer[(frame * _channels) + channel]
                    : 0f;

                buffer[offset + (frame * _channels) + channel] = ProcessSample(channel, sample);
            }
        }

        return requestedFrames * _channels;
    }

    private float ProcessSample(int channel, float inputSample)
    {
        lock (_sync)
        {
            var writeIndex = (_writeFrameIndex * _channels) + channel;
            _history[writeIndex] = inputSample;

            float output = 0f;
            if (_framesWritten >= _delayFrames)
            {
                var readFrameIndex = _writeFrameIndex - _delayFrames;
                while (readFrameIndex < 0)
                {
                    readFrameIndex += _capacityFrames;
                }

                var readIndex = (readFrameIndex * _channels) + channel;
                output = _history[readIndex];
            }

            if (channel == _channels - 1)
            {
                _writeFrameIndex = (_writeFrameIndex + 1) % _capacityFrames;
                _framesWritten++;
            }

            return output;
        }
    }
}
