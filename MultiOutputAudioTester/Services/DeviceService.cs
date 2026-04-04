using MultiOutputAudioTester.Models;
using NAudio.CoreAudioApi;

namespace MultiOutputAudioTester.Services;

public sealed class DeviceService
{
    private readonly AppLogger _logger;

    public DeviceService(AppLogger logger)
    {
        _logger = logger;
    }

    public IReadOnlyList<AudioDeviceInfo> GetInputDevices()
    {
        return GetDevices(DataFlow.Capture);
    }

    public IReadOnlyList<AudioDeviceInfo> GetPlaybackDevices()
    {
        return GetDevices(DataFlow.Render);
    }

    private IReadOnlyList<AudioDeviceInfo> GetDevices(DataFlow flow)
    {
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            return enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active | DeviceState.Unplugged | DeviceState.Disabled)
                .Select(device => new AudioDeviceInfo
                {
                    Id = device.ID,
                    Name = device.FriendlyName,
                    State = device.State.ToString(),
                    IsActive = device.State == DeviceState.Active
                })
                .OrderByDescending(device => device.IsActive)
                .ThenBy(device => device.Name)
                .ToList();
        }
        catch (Exception ex)
        {
            _logger.Error($"Failed to enumerate {flow} devices.", ex);
            return [];
        }
    }
}
