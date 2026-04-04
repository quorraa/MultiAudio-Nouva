using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace MultiOutputAudioTester.Services;

public sealed class ChannelMapSampleProvider : ISampleProvider
{
    private readonly ISampleProvider _source;
    private readonly int _inputChannels;

    public ChannelMapSampleProvider(ISampleProvider source)
    {
        _source = source;
        _inputChannels = source.WaveFormat.Channels;
        WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(source.WaveFormat.SampleRate, 2);
    }

    public WaveFormat WaveFormat { get; }

    public int Read(float[] buffer, int offset, int count)
    {
        var framesRequested = count / 2;
        var sourceSamplesNeeded = framesRequested * _inputChannels;
        if (sourceSamplesNeeded <= 0)
        {
            return 0;
        }

        var sourceBuffer = new float[sourceSamplesNeeded];
        var sourceSamplesRead = _source.Read(sourceBuffer, 0, sourceSamplesNeeded);
        if (sourceSamplesRead <= 0)
        {
            return 0;
        }

        var sourceFramesRead = sourceSamplesRead / _inputChannels;
        for (var frame = 0; frame < sourceFramesRead; frame++)
        {
            var sourceOffset = frame * _inputChannels;
            var left = sourceBuffer[sourceOffset];
            var right = _inputChannels > 1 ? sourceBuffer[sourceOffset + 1] : left;

            buffer[offset + (frame * 2)] = left;
            buffer[offset + (frame * 2) + 1] = right;
        }

        return sourceFramesRead * 2;
    }
}
