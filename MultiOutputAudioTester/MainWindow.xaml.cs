using System;
using System.Windows;
using MultiOutputAudioTester.Services;
using MultiOutputAudioTester.ViewModels;

namespace MultiOutputAudioTester;

public partial class MainWindow : Window
{
    private readonly MainViewModel _viewModel;

    public MainWindow()
    {
        InitializeComponent();

        var logger = new AppLogger();
        var configService = new ConfigurationService(logger);
        var deviceService = new DeviceService(logger);
        var engineService = new AudioEngineService(logger);
        var calibrationService = new CalibrationService(logger);

        _viewModel = new MainViewModel(deviceService, configService, engineService, calibrationService, logger);
        DataContext = _viewModel;

        Loaded += OnLoaded;
        Closed += OnClosed;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        await _viewModel.InitializeAsync();
    }

    private async void OnClosed(object? sender, EventArgs e)
    {
        await _viewModel.DisposeAsync();
    }
}
