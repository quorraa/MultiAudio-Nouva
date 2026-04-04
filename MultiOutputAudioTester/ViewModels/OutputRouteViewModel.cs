using System.Collections.ObjectModel;
using MultiOutputAudioTester.Helpers;
using MultiOutputAudioTester.Models;

namespace MultiOutputAudioTester.ViewModels;

public sealed class OutputRouteViewModel : ObservableObject
{
    private readonly Action<OutputRouteViewModel> _onChanged;
    private readonly Action<OutputRouteViewModel> _onRemoveRequested;
    private int _slotIndex;
    private AudioDeviceInfo? _selectedDevice;
    private double _volumePercent = 100;
    private int _delayMilliseconds;
    private bool _isTimingMaster;
    private double _meterLevel;
    private string _statusText = "Idle";
    private double _bufferedMilliseconds;
    private double _playbackRateRatio = 1.0;
    private double _autoSyncPlaybackRateRatio = 1.0;
    private int _effectiveDelayMilliseconds;
    private int _autoDelayMilliseconds;
    private double _estimatedArrivalMilliseconds;
    private double _syncConfidence;
    private double _markerLevelPercent;
    private string _syncStatusText = "Manual";
    private SyncLockState _syncLockState = SyncLockState.Disabled;
    private bool _canRemove = true;

    public OutputRouteViewModel(int slotIndex, Action<OutputRouteViewModel> onChanged, Action<OutputRouteViewModel> onRemoveRequested)
    {
        _slotIndex = slotIndex;
        _onChanged = onChanged;
        _onRemoveRequested = onRemoveRequested;
        RemoveCommand = new RelayCommand(() => _onRemoveRequested(this), () => CanRemove);
    }

    public int SlotIndex
    {
        get => _slotIndex;
        private set
        {
            if (SetProperty(ref _slotIndex, value))
            {
                OnPropertyChanged(nameof(Title));
            }
        }
    }

    public string Title => $"Output {SlotIndex}";

    public ObservableCollection<AudioDeviceInfo> AvailableDevices { get; } = [];

    public RelayCommand RemoveCommand { get; }

    public AudioDeviceInfo? SelectedDevice
    {
        get => _selectedDevice;
        set
        {
            if (SetProperty(ref _selectedDevice, value))
            {
                OnPropertyChanged(nameof(IsActiveSelection));
                _onChanged(this);
            }
        }
    }

    public double VolumePercent
    {
        get => _volumePercent;
        set
        {
            var clamped = Math.Clamp(value, 0, 100);
            if (SetProperty(ref _volumePercent, clamped))
            {
                OnPropertyChanged(nameof(VolumeDisplay));
                _onChanged(this);
            }
        }
    }

    public int DelayMilliseconds
    {
        get => _delayMilliseconds;
        set
        {
            var clamped = Math.Clamp(value, 0, 2000);
            if (SetProperty(ref _delayMilliseconds, clamped))
            {
                OnPropertyChanged(nameof(DelayDisplay));
                _onChanged(this);
            }
        }
    }

    public bool IsTimingMaster
    {
        get => _isTimingMaster;
        set
        {
            if (SetProperty(ref _isTimingMaster, value))
            {
                OnPropertyChanged(nameof(RoleDisplay));
                _onChanged(this);
            }
        }
    }

    public double MeterLevel
    {
        get => _meterLevel;
        set => SetProperty(ref _meterLevel, value);
    }

    public string StatusText
    {
        get => _statusText;
        set => SetProperty(ref _statusText, value);
    }

    public double BufferedMilliseconds
    {
        get => _bufferedMilliseconds;
        set
        {
            if (SetProperty(ref _bufferedMilliseconds, value))
            {
                OnPropertyChanged(nameof(BufferedStatus));
            }
        }
    }

    public double PlaybackRateRatio
    {
        get => _playbackRateRatio;
        set
        {
            if (SetProperty(ref _playbackRateRatio, value))
            {
                OnPropertyChanged(nameof(BufferedStatus));
            }
        }
    }

    public double AutoSyncPlaybackRateRatio
    {
        get => _autoSyncPlaybackRateRatio;
        set
        {
            if (SetProperty(ref _autoSyncPlaybackRateRatio, value))
            {
                OnPropertyChanged(nameof(AutoSyncDetail));
            }
        }
    }

    public int EffectiveDelayMilliseconds
    {
        get => _effectiveDelayMilliseconds;
        set
        {
            if (SetProperty(ref _effectiveDelayMilliseconds, value))
            {
                OnPropertyChanged(nameof(AutoSyncDetail));
            }
        }
    }

    public int AutoDelayMilliseconds
    {
        get => _autoDelayMilliseconds;
        set
        {
            if (SetProperty(ref _autoDelayMilliseconds, value))
            {
                OnPropertyChanged(nameof(AutoSyncDetail));
            }
        }
    }

    public double EstimatedArrivalMilliseconds
    {
        get => _estimatedArrivalMilliseconds;
        set
        {
            if (SetProperty(ref _estimatedArrivalMilliseconds, value))
            {
                OnPropertyChanged(nameof(AutoSyncDetail));
            }
        }
    }

    public double SyncConfidence
    {
        get => _syncConfidence;
        set
        {
            if (SetProperty(ref _syncConfidence, value))
            {
                OnPropertyChanged(nameof(AutoSyncDetail));
            }
        }
    }

    public double MarkerLevelPercent
    {
        get => _markerLevelPercent;
        set
        {
            if (SetProperty(ref _markerLevelPercent, value))
            {
                OnPropertyChanged(nameof(AutoSyncDetail));
            }
        }
    }

    public SyncLockState SyncLockState
    {
        get => _syncLockState;
        set
        {
            if (SetProperty(ref _syncLockState, value))
            {
                OnPropertyChanged(nameof(AutoSyncSummary));
            }
        }
    }

    public string SyncStatusText
    {
        get => _syncStatusText;
        set
        {
            if (SetProperty(ref _syncStatusText, value))
            {
                OnPropertyChanged(nameof(AutoSyncSummary));
            }
        }
    }

    public bool IsActiveSelection => SelectedDevice?.IsActive == true;

    public bool CanRemove
    {
        get => _canRemove;
        private set
        {
            if (SetProperty(ref _canRemove, value))
            {
                RemoveCommand.RaiseCanExecuteChanged();
            }
        }
    }

    public string VolumeDisplay => $"{VolumePercent:F0}%";

    public string DelayDisplay => $"{DelayMilliseconds} ms";

    public string BufferedStatus => $"Buffered: {BufferedMilliseconds:F0} ms | Drift: {PlaybackRateRatio:F4}x";

    public string RoleDisplay => IsTimingMaster ? "Timing Master" : "Slave";

    public string AutoSyncSummary => $"{SyncLockState}: {SyncStatusText}";

    public string AutoSyncDetail =>
        $"Arrival: {EstimatedArrivalMilliseconds:F0} ms | Auto Delay: {AutoDelayMilliseconds} ms | " +
        $"Effective: {EffectiveDelayMilliseconds} ms | Sync Rate: {AutoSyncPlaybackRateRatio:F4}x | " +
        $"Confidence: {SyncConfidence:P0}";

    public OutputRouteConfig ToConfig()
    {
        return new OutputRouteConfig
        {
            SlotIndex = SlotIndex,
            DeviceId = SelectedDevice?.Id,
            VolumePercent = VolumePercent,
            DelayMilliseconds = DelayMilliseconds,
            IsTimingMaster = IsTimingMaster
        };
    }

    public void ApplyConfig(OutputRouteConfig config)
    {
        VolumePercent = config.VolumePercent;
        DelayMilliseconds = config.DelayMilliseconds;
        IsTimingMaster = config.IsTimingMaster;
    }

    public void UpdateSlotIndex(int slotIndex)
    {
        SlotIndex = slotIndex;
    }

    public void UpdateCanRemove(bool canRemove)
    {
        CanRemove = canRemove;
    }
}
