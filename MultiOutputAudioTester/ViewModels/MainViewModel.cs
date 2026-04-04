using System.Collections.ObjectModel;
using System.Text;
using System.Windows;
using MultiOutputAudioTester.Config;
using MultiOutputAudioTester.Helpers;
using MultiOutputAudioTester.Models;
using MultiOutputAudioTester.Services;

namespace MultiOutputAudioTester.ViewModels;

public sealed class MainViewModel : ObservableObject, IAsyncDisposable
{
    private readonly DeviceService _deviceService;
    private readonly ConfigurationService _configurationService;
    private readonly AudioEngineService _audioEngineService;
    private readonly CalibrationService _calibrationService;
    private readonly AppLogger _logger;

    private readonly RelayCommand _startCommand;
    private readonly RelayCommand _stopCommand;
    private readonly RelayCommand _refreshDevicesCommand;
    private readonly RelayCommand _addOutputCommand;
    private readonly RelayCommand _clearLogsCommand;
    private readonly RelayCommand _copyLogsCommand;
    private readonly RelayCommand _runCalibrationCommand;

    private readonly ObservableCollection<OutputRouteViewModel> _outputs;

    private AppConfig _config = new();
    private AudioDeviceInfo? _selectedInputDevice;
    private AudioDeviceInfo? _selectedCalibrationInputDevice;
    private bool _useTestTone;
    private bool _isRunning;
    private bool _isCalibrating;
    private bool _isInitializing;
    private CancellationTokenSource? _saveDebounceCts;
    private double _captureLevel;
    private double _roomMicLevel;
    private double _masterVolumePercent = 100;
    private double _markerLevelPercent = 1.6;
    private AutoSyncMode _autoSyncMode = AutoSyncMode.MonitorOnly;
    private string _captureStatusText = "Idle";
    private string _sessionStatusMessage = "Ready";
    private string _calibrationStatusMessage = "Calibration idle.";
    private string _lastErrorMessage = string.Empty;

    public MainViewModel(
        DeviceService deviceService,
        ConfigurationService configurationService,
        AudioEngineService audioEngineService,
        CalibrationService calibrationService,
        AppLogger logger)
    {
        _deviceService = deviceService;
        _configurationService = configurationService;
        _audioEngineService = audioEngineService;
        _calibrationService = calibrationService;
        _logger = logger;

        _isInitializing = true;
        _outputs = [];
        EnsureOutputViewModels(3);
        _isInitializing = false;

        Outputs = new ReadOnlyObservableCollection<OutputRouteViewModel>(_outputs);

        _startCommand = new RelayCommand(Start, () => !_isRunning && !_isCalibrating);
        _stopCommand = new RelayCommand(Stop, () => _isRunning);
        _refreshDevicesCommand = new RelayCommand(RefreshDevices, () => !_isRunning && !_isCalibrating);
        _addOutputCommand = new RelayCommand(AddOutput, () => !_isRunning && !_isCalibrating);
        _clearLogsCommand = new RelayCommand(() => LogEntries.Clear());
        _copyLogsCommand = new RelayCommand(CopyLogs);
        _runCalibrationCommand = new RelayCommand(RunCalibration, () => !_isCalibrating);

        _logger.EntryLogged += OnEntryLogged;
        _audioEngineService.CaptureLevelChanged += OnCaptureLevelChanged;
        _audioEngineService.RoomMicLevelChanged += OnRoomMicLevelChanged;
        _audioEngineService.OutputStatusChanged += OnOutputStatusChanged;
        _audioEngineService.ErrorRaised += OnEngineErrorRaised;

        _logger.Info("Application booted.");
    }

    public ObservableCollection<AudioDeviceInfo> InputDevices { get; } = [];

    public ReadOnlyObservableCollection<OutputRouteViewModel> Outputs { get; }

    public ObservableCollection<LogEntry> LogEntries { get; } = [];

    public RelayCommand StartCommand => _startCommand;

    public RelayCommand StopCommand => _stopCommand;

    public RelayCommand RefreshDevicesCommand => _refreshDevicesCommand;

    public RelayCommand AddOutputCommand => _addOutputCommand;

    public RelayCommand ClearLogsCommand => _clearLogsCommand;

    public RelayCommand CopyLogsCommand => _copyLogsCommand;

    public RelayCommand RunCalibrationCommand => _runCalibrationCommand;

    public AudioDeviceInfo? SelectedInputDevice
    {
        get => _selectedInputDevice;
        set
        {
            if (SetProperty(ref _selectedInputDevice, value) && !_isInitializing)
            {
                SaveConfigSoon();
            }
        }
    }

    public AudioDeviceInfo? SelectedCalibrationInputDevice
    {
        get => _selectedCalibrationInputDevice;
        set
        {
            if (SetProperty(ref _selectedCalibrationInputDevice, value) && !_isInitializing)
            {
                if (_audioEngineService.IsRunning)
                {
                    _audioEngineService.UpdateAutoSyncSettings(BuildAutoSyncSettings(), value?.Id, GetTimingMasterSlotIndex());
                }

                SaveConfigSoon();
            }
        }
    }

    public bool UseTestTone
    {
        get => _useTestTone;
        set
        {
            if (SetProperty(ref _useTestTone, value) && !_isInitializing)
            {
                SaveConfigSoon();
            }
        }
    }

    public double CaptureLevel
    {
        get => _captureLevel;
        set => SetProperty(ref _captureLevel, value);
    }

    public double RoomMicLevel
    {
        get => _roomMicLevel;
        set => SetProperty(ref _roomMicLevel, value);
    }

    public double MasterVolumePercent
    {
        get => _masterVolumePercent;
        set
        {
            var clamped = Math.Clamp(value, 0, 100);
            if (SetProperty(ref _masterVolumePercent, clamped))
            {
                OnPropertyChanged(nameof(MasterVolumeDisplay));

                if (_audioEngineService.IsRunning)
                {
                    _audioEngineService.UpdateMasterVolume(clamped);
                }

                if (!_isInitializing)
                {
                    SaveConfigSoon();
                }
            }
        }
    }

    public string MasterVolumeDisplay => $"{MasterVolumePercent:F0}%";

    public Array AutoSyncModes => Enum.GetValues(typeof(AutoSyncMode));

    public AutoSyncMode AutoSyncMode
    {
        get => _autoSyncMode;
        set
        {
            if (SetProperty(ref _autoSyncMode, value))
            {
                OnPropertyChanged(nameof(AutoSyncModeSummary));

                if (_audioEngineService.IsRunning)
                {
                    _audioEngineService.UpdateAutoSyncSettings(BuildAutoSyncSettings(), SelectedCalibrationInputDevice?.Id, GetTimingMasterSlotIndex());
                }

                if (!_isInitializing)
                {
                    SaveConfigSoon();
                }
            }
        }
    }

    public string AutoSyncModeSummary => AutoSyncMode switch
    {
        AutoSyncMode.Off => "Off",
        AutoSyncMode.MonitorOnly => "Monitor Only",
        _ => "Control"
    };

    public double MarkerLevelPercent
    {
        get => _markerLevelPercent;
        set
        {
            var clamped = Math.Clamp(value, 0, 5);
            if (SetProperty(ref _markerLevelPercent, clamped))
            {
                OnPropertyChanged(nameof(MarkerLevelDisplay));

                if (_audioEngineService.IsRunning)
                {
                    _audioEngineService.UpdateAutoSyncSettings(BuildAutoSyncSettings(), SelectedCalibrationInputDevice?.Id, GetTimingMasterSlotIndex());
                }

                if (!_isInitializing)
                {
                    SaveConfigSoon();
                }
            }
        }
    }

    public string MarkerLevelDisplay => $"{MarkerLevelPercent:F1}%";

    public string CaptureStatusText
    {
        get => _captureStatusText;
        set => SetProperty(ref _captureStatusText, value);
    }

    public string SessionStatusMessage
    {
        get => _sessionStatusMessage;
        set => SetProperty(ref _sessionStatusMessage, value);
    }

    public string CalibrationStatusMessage
    {
        get => _calibrationStatusMessage;
        set => SetProperty(ref _calibrationStatusMessage, value);
    }

    public string LastErrorMessage
    {
        get => _lastErrorMessage;
        set => SetProperty(ref _lastErrorMessage, value);
    }

    public int OutputCount => Outputs.Count;

    public async Task InitializeAsync()
    {
        _isInitializing = true;
        _config = await _configurationService.LoadAsync();
        RefreshDevices();
        ApplyConfigToUi();
        _isInitializing = false;
        SessionStatusMessage = $"Config path: {_configurationService.ConfigPath}";
    }

    public async ValueTask DisposeAsync()
    {
        _logger.Info("Shutting down application.");
        _saveDebounceCts?.Cancel();
        _logger.EntryLogged -= OnEntryLogged;
        _audioEngineService.CaptureLevelChanged -= OnCaptureLevelChanged;
        _audioEngineService.RoomMicLevelChanged -= OnRoomMicLevelChanged;
        _audioEngineService.OutputStatusChanged -= OnOutputStatusChanged;
        _audioEngineService.ErrorRaised -= OnEngineErrorRaised;
        await _audioEngineService.DisposeAsync();
    }

    private void RefreshDevices()
    {
        EnsureOutputViewModels(Math.Max(1, _config.Outputs.Count));

        var previousInputId = SelectedInputDevice?.Id ?? _config.InputDeviceId;
        var previousCalibrationId = SelectedCalibrationInputDevice?.Id ?? _config.CalibrationInputDeviceId;
        var previousOutputIds = Outputs.Select(output => output.SelectedDevice?.Id).ToArray();

        InputDevices.Clear();
        foreach (var device in _deviceService.GetInputDevices())
        {
            InputDevices.Add(device);
        }

        var playbackDevices = _deviceService.GetPlaybackDevices();
        foreach (var output in Outputs)
        {
            output.AvailableDevices.Clear();
            foreach (var device in playbackDevices)
            {
                output.AvailableDevices.Add(device);
            }
        }

        SelectedInputDevice = InputDevices.FirstOrDefault(device => device.Id == previousInputId)
            ?? InputDevices.FirstOrDefault(device => device.IsActive);

        SelectedCalibrationInputDevice = InputDevices.FirstOrDefault(device => device.Id == previousCalibrationId)
            ?? InputDevices.FirstOrDefault(device => device.IsActive);

        for (var index = 0; index < Outputs.Count; index++)
        {
            var targetId = index < previousOutputIds.Length && !string.IsNullOrWhiteSpace(previousOutputIds[index])
                ? previousOutputIds[index]
                : _config.Outputs[index].DeviceId;

            Outputs[index].SelectedDevice = Outputs[index].AvailableDevices.FirstOrDefault(device => device.Id == targetId);
        }

        _logger.Info($"Refreshed devices. Inputs={InputDevices.Count}, outputs={playbackDevices.Count}.");
    }

    private void ApplyConfigToUi()
    {
        EnsureOutputViewModels(Math.Max(1, _config.Outputs.Count));
        UseTestTone = _config.UseTestTone;
        MasterVolumePercent = _config.MasterVolumePercent;
        AutoSyncMode = _config.AutoSync.Mode;
        MarkerLevelPercent = _config.AutoSync.MarkerLevelPercent;

        SelectedInputDevice = InputDevices.FirstOrDefault(device => device.Id == _config.InputDeviceId)
            ?? InputDevices.FirstOrDefault(device => device.IsActive);

        SelectedCalibrationInputDevice = InputDevices.FirstOrDefault(device => device.Id == _config.CalibrationInputDeviceId)
            ?? InputDevices.FirstOrDefault(device => device.IsActive);

        for (var index = 0; index < Outputs.Count; index++)
        {
            var output = Outputs[index];
            output.ApplyConfig(_config.Outputs[index]);
            output.SelectedDevice = output.AvailableDevices.FirstOrDefault(device => device.Id == _config.Outputs[index].DeviceId);
        }
    }

    private async void Start()
    {
        try
        {
            await StartStreamingAsync();
        }
        catch
        {
        }
    }

    private async void Stop()
    {
        try
        {
            await StopStreamingAsync();
        }
        catch
        {
        }
    }

    private async void RunCalibration()
    {
        var wasRunning = _isRunning;
        try
        {
            LastErrorMessage = string.Empty;
            var outputConfigs = BuildValidatedOutputConfigs("Select a playback device for every output route before running calibration.");

            if (SelectedCalibrationInputDevice is null)
            {
                throw new InvalidOperationException("Select a calibration microphone before running calibration.");
            }

            _isCalibrating = true;
            UpdateCommandStates();
            CalibrationStatusMessage = wasRunning
                ? "Calibration running. Live stream paused while calibration audio plays."
                : "Calibration running. Keep the microphone at the listening position and stay quiet.";
            SessionStatusMessage = wasRunning
                ? "Pausing live stream for calibration..."
                : "Running calibration bursts...";

            if (wasRunning)
            {
                await StopStreamingAsync(
                    sessionStoppedMessage: "Live stream paused for calibration.",
                    captureStoppedMessage: "Paused for calibration");
            }

            SessionStatusMessage = "Running calibration bursts...";

            var result = await _calibrationService.RunCalibrationAsync(SelectedCalibrationInputDevice.Id, outputConfigs);
            var successful = result.Outputs.Where(output => output.Succeeded).OrderBy(output => output.SlotIndex).ToList();

            if (successful.Count == 0)
            {
                CalibrationStatusMessage = "Calibration failed. No burst arrivals were detected.";
                SessionStatusMessage = "Calibration finished without usable measurements.";
                LastErrorMessage = "No stable latency clusters were found. Check the latest calibration diagnostics folder and copied logs before retrying.";
                return;
            }

            foreach (var output in successful)
            {
                var viewModel = Outputs.First(item => item.SlotIndex == output.SlotIndex);
                viewModel.DelayMilliseconds = output.SuggestedDelayMilliseconds;
            }

            CalibrationStatusMessage = $"Calibration applied: {result.Summary}";
            SessionStatusMessage = "Calibration finished.";
            _logger.Info($"Calibration summary: {result.Summary}");

            var failed = result.Outputs.Where(output => !output.Succeeded).ToList();
            if (failed.Count > 0)
            {
                LastErrorMessage = string.Join(" | ", failed.Select(output => $"O{output.SlotIndex}: {output.Message}"));
            }

            SaveConfigSoon();
        }
        catch (Exception ex)
        {
            CalibrationStatusMessage = "Calibration failed.";
            SessionStatusMessage = "Calibration failed.";
            LastErrorMessage = ex.Message;
            _logger.Error("Calibration request failed.", ex);
        }
        finally
        {
            _isCalibrating = false;
            if (wasRunning)
            {
                try
                {
                    SessionStatusMessage = "Restoring live stream after calibration...";
                    await StartStreamingAsync();
                    SessionStatusMessage = "Streaming is live after calibration.";
                }
                catch (Exception ex)
                {
                    CalibrationStatusMessage = "Calibration finished, but stream restore failed.";
                    SessionStatusMessage = "Stream restore failed after calibration.";
                    LastErrorMessage = ex.Message;
                    _logger.Error("Failed to restore live stream after calibration.", ex);
                }
            }

            UpdateCommandStates();
        }
    }

    private List<OutputRouteConfig> BuildValidatedOutputConfigs(string missingDeviceMessage)
    {
        var outputConfigs = Outputs.Select(output => output.ToConfig()).ToList();
        var masterSlotIndex = outputConfigs.FirstOrDefault(output => output.IsTimingMaster)?.SlotIndex ?? 1;
        foreach (var output in outputConfigs)
        {
            output.IsTimingMaster = output.SlotIndex == masterSlotIndex;
        }

        if (outputConfigs.Any(output => string.IsNullOrWhiteSpace(output.DeviceId)))
        {
            throw new InvalidOperationException(missingDeviceMessage);
        }

        var duplicateIds = outputConfigs.GroupBy(output => output.DeviceId)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .ToList();

        if (duplicateIds.Count > 0)
        {
            throw new InvalidOperationException("Each output route must use a different playback device in v1.");
        }

        return outputConfigs;
    }

    private async Task StartStreamingAsync()
    {
        try
        {
            LastErrorMessage = string.Empty;
            var outputConfigs = BuildValidatedOutputConfigs("Select a playback device for every output route before starting.");

            CaptureStatusText = UseTestTone
                ? "Generating internal test tone"
                : $"Capturing from: {SelectedInputDevice?.DisplayName ?? "None"}";

            SessionStatusMessage = "Starting audio engine...";
            await _audioEngineService.StartAsync(
                SelectedInputDevice?.Id,
                outputConfigs,
                UseTestTone,
                MasterVolumePercent,
                BuildAutoSyncSettings(),
                SelectedCalibrationInputDevice?.Id);
            _isRunning = true;
            UpdateCommandStates();
            SessionStatusMessage = "Streaming is live.";
            SaveConfigSoon();
        }
        catch (Exception ex)
        {
            LastErrorMessage = ex.Message;
            SessionStatusMessage = "Start failed.";
            _logger.Error("Start request failed.", ex);
            throw;
        }
    }

    private async Task StopStreamingAsync(string sessionStoppedMessage = "Streaming stopped.", string captureStoppedMessage = "Stopped")
    {
        try
        {
            SessionStatusMessage = "Stopping audio engine...";
            await _audioEngineService.StopAsync();
            _isRunning = false;
            CaptureLevel = 0;
            CaptureStatusText = captureStoppedMessage;
            SessionStatusMessage = sessionStoppedMessage;
            UpdateCommandStates();
        }
        catch (Exception ex)
        {
            LastErrorMessage = ex.Message;
            _logger.Error("Stop request failed.", ex);
            throw;
        }
    }

    private void UpdateCommandStates()
    {
        _startCommand.RaiseCanExecuteChanged();
        _stopCommand.RaiseCanExecuteChanged();
        _refreshDevicesCommand.RaiseCanExecuteChanged();
        _addOutputCommand.RaiseCanExecuteChanged();
        _runCalibrationCommand.RaiseCanExecuteChanged();
        UpdateOutputManagementState();
    }

    private void OnOutputRouteChanged(OutputRouteViewModel output)
    {
        if (_isInitializing)
        {
            return;
        }

        if (output.IsTimingMaster)
        {
            foreach (var other in Outputs.Where(candidate => candidate != output && candidate.IsTimingMaster))
            {
                other.IsTimingMaster = false;
            }
        }
        else if (!Outputs.Any(candidate => candidate.IsTimingMaster))
        {
            output.IsTimingMaster = true;
        }

        if (_audioEngineService.IsRunning)
        {
            _audioEngineService.UpdateOutputSettings(output.SlotIndex, output.VolumePercent, output.DelayMilliseconds);
            _audioEngineService.UpdateAutoSyncSettings(BuildAutoSyncSettings(), SelectedCalibrationInputDevice?.Id, GetTimingMasterSlotIndex());
        }

        SaveConfigSoon();
    }

    private void AddOutput()
    {
        if (_isRunning || _isCalibrating)
        {
            return;
        }

        var output = CreateOutputViewModel(_outputs.Count + 1);
        foreach (var device in _deviceService.GetPlaybackDevices())
        {
            output.AvailableDevices.Add(device);
        }

        _outputs.Add(output);
        UpdateOutputManagementState();
        SaveConfigSoon();
        _logger.Info($"Added output route {_outputs.Count}.");
    }

    private void RemoveOutput(OutputRouteViewModel output)
    {
        if (_isRunning || _isCalibrating || _outputs.Count <= 1)
        {
            return;
        }

        _outputs.Remove(output);
        for (var index = 0; index < _outputs.Count; index++)
        {
            _outputs[index].UpdateSlotIndex(index + 1);
        }

        if (_outputs.Count > 0 && !_outputs.Any(item => item.IsTimingMaster))
        {
            _outputs[0].IsTimingMaster = true;
        }

        UpdateOutputManagementState();
        SaveConfigSoon();
        _logger.Info($"Removed output route. Remaining outputs={_outputs.Count}.");
    }

    private void EnsureOutputViewModels(int count)
    {
        count = Math.Max(1, count);

        while (_outputs.Count < count)
        {
            _outputs.Add(CreateOutputViewModel(_outputs.Count + 1));
        }

        while (_outputs.Count > count)
        {
            _outputs.RemoveAt(_outputs.Count - 1);
        }

        for (var index = 0; index < _outputs.Count; index++)
        {
            _outputs[index].UpdateSlotIndex(index + 1);
        }

        if (_outputs.Count > 0 && !_outputs.Any(output => output.IsTimingMaster))
        {
            _outputs[0].IsTimingMaster = true;
        }

        UpdateOutputManagementState();
    }

    private OutputRouteViewModel CreateOutputViewModel(int slotIndex)
    {
        return new OutputRouteViewModel(slotIndex, OnOutputRouteChanged, RemoveOutput);
    }

    private void UpdateOutputManagementState()
    {
        var canRemove = _outputs.Count > 1 && !_isRunning && !_isCalibrating;
        foreach (var output in _outputs)
        {
            output.UpdateCanRemove(canRemove);
        }

        OnPropertyChanged(nameof(OutputCount));
    }

    private void SaveConfigSoon()
    {
        _config.InputDeviceId = SelectedInputDevice?.Id;
        _config.CalibrationInputDeviceId = SelectedCalibrationInputDevice?.Id;
        _config.UseTestTone = UseTestTone;
        _config.MasterVolumePercent = MasterVolumePercent;
        _config.AutoSync = BuildAutoSyncSettings();
        _config.Outputs = Outputs.Select(output => output.ToConfig()).ToList();
        _config.EnsureDefaults();

        _saveDebounceCts?.Cancel();
        _saveDebounceCts = new CancellationTokenSource();
        var token = _saveDebounceCts.Token;

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(350, token);
                await _configurationService.SaveAsync(_config);
            }
            catch (OperationCanceledException)
            {
            }
        }, token);
    }

    private void CopyLogs()
    {
        try
        {
            var builder = new StringBuilder();
            builder.AppendLine("Multi Output Audio Tester Log Dump");
            builder.AppendLine($"Captured At: {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
            builder.AppendLine($"Session Status: {SessionStatusMessage}");
            builder.AppendLine($"Calibration Status: {CalibrationStatusMessage}");
            builder.AppendLine($"Last Error: {LastErrorMessage}");
            builder.AppendLine($"Capture Input: {SelectedInputDevice?.DisplayName ?? "None"}");
            builder.AppendLine($"Calibration Mic: {SelectedCalibrationInputDevice?.DisplayName ?? "None"}");
            builder.AppendLine($"Use Test Tone: {UseTestTone}");
            builder.AppendLine($"Master Volume: {MasterVolumePercent:F0}%");
            builder.AppendLine($"Auto Sync Mode: {AutoSyncModeSummary}");
            builder.AppendLine($"Marker Level: {MarkerLevelPercent:F1}%");
            builder.AppendLine("Outputs:");

            foreach (var output in Outputs.OrderBy(output => output.SlotIndex))
            {
                builder.AppendLine(
                    $"  Output {output.SlotIndex}: Device={output.SelectedDevice?.DisplayName ?? "None"}, " +
                    $"Volume={output.VolumePercent:F0}%, Delay={output.DelayMilliseconds} ms, " +
                    $"AutoDelay={output.AutoDelayMilliseconds} ms, EffectiveDelay={output.EffectiveDelayMilliseconds} ms, " +
                    $"Arrival={output.EstimatedArrivalMilliseconds:F0} ms, Confidence={output.SyncConfidence:P0}, " +
                    $"Sync={output.SyncLockState}, Status={output.StatusText}, Buffered={output.BufferedMilliseconds:F0} ms");
            }

            builder.AppendLine("Log Entries:");
            foreach (var entry in LogEntries)
            {
                builder.AppendLine(entry.DisplayText);
            }

            Clipboard.SetText(builder.ToString());
            SessionStatusMessage = "Logs copied to clipboard.";
            _logger.Info("Copied log dump to clipboard.");
        }
        catch (Exception ex)
        {
            LastErrorMessage = ex.Message;
            _logger.Error("Failed to copy logs to clipboard.", ex);
        }
    }

    private async void OnEntryLogged(object? sender, LogEntry e)
    {
        await Application.Current.Dispatcher.InvokeAsync(() =>
        {
            LogEntries.Add(e);
            while (LogEntries.Count > 300)
            {
                LogEntries.RemoveAt(0);
            }
        });
    }

    private async void OnCaptureLevelChanged(object? sender, float level)
    {
        await Application.Current.Dispatcher.InvokeAsync(() =>
        {
            CaptureLevel = level;
        });
    }

    private async void OnRoomMicLevelChanged(object? sender, float level)
    {
        await Application.Current.Dispatcher.InvokeAsync(() =>
        {
            RoomMicLevel = level;
        });
    }

    private async void OnOutputStatusChanged(object? sender, OutputPipelineStatus status)
    {
        await Application.Current.Dispatcher.InvokeAsync(() =>
        {
            var viewModel = Outputs.First(output => output.SlotIndex == status.SlotIndex);
            viewModel.MeterLevel = status.MeterLevel;
            viewModel.BufferedMilliseconds = status.BufferedMilliseconds;
            viewModel.PlaybackRateRatio = status.PlaybackRateRatio;
            viewModel.AutoSyncPlaybackRateRatio = status.AutoSyncPlaybackRateRatio;
            viewModel.EffectiveDelayMilliseconds = status.EffectiveDelayMilliseconds;
            viewModel.AutoDelayMilliseconds = status.AutoDelayMilliseconds;
            viewModel.EstimatedArrivalMilliseconds = status.EstimatedArrivalMilliseconds;
            viewModel.SyncConfidence = status.SyncConfidence;
            viewModel.MarkerLevelPercent = status.MarkerLevelPercent;
            viewModel.IsTimingMaster = status.IsTimingMaster;
            viewModel.SyncLockState = status.SyncLockState;
            viewModel.SyncStatusText = status.SyncStatusText;
            viewModel.StatusText = status.StatusText;
        });
    }

    private async void OnEngineErrorRaised(object? sender, string message)
    {
        await Application.Current.Dispatcher.InvokeAsync(() =>
        {
            LastErrorMessage = message;
            SessionStatusMessage = "Engine reported an error.";
        });
    }

    private AutoSyncSettings BuildAutoSyncSettings()
    {
        return new AutoSyncSettings
        {
            Mode = AutoSyncMode,
            MarkerLevelPercent = MarkerLevelPercent
        };
    }

    private int GetTimingMasterSlotIndex()
    {
        return Outputs.FirstOrDefault(output => output.IsTimingMaster)?.SlotIndex ?? 1;
    }
}
