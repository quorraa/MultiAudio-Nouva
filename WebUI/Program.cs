using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Net;
using System.Net.Sockets;
using MultiOutputAudioTester.Services;
using WebUI.Models;
using WebUI.Services;

var builder = WebApplication.CreateBuilder(args);

var port = ResolvePort();
builder.WebHost.ConfigureKestrel(options =>
{
    options.ListenLocalhost(port);
});

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

builder.Services.AddSingleton<AppLogger>();
builder.Services.AddSingleton<DeviceService>();
builder.Services.AddSingleton<ConfigurationService>();
builder.Services.AddSingleton<AudioEngineService>();
builder.Services.AddSingleton<CalibrationService>();
builder.Services.AddSingleton<AudioControlService>();
builder.Services.AddSingleton<IHostedService>(serviceProvider => serviceProvider.GetRequiredService<AudioControlService>());

var app = builder.Build();
var launchUrl = $"http://localhost:{port}";

app.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine($"MultiAudio Nouva Web Widget listening on {launchUrl}");
    TryOpenBrowser(launchUrl);
});

app.Use(async (context, next) =>
{
    var path = context.Request.Path.Value ?? "";
    if (path.Equals("/", StringComparison.OrdinalIgnoreCase) ||
        path.Equals("/index.html", StringComparison.OrdinalIgnoreCase))
    {
        var env = context.RequestServices.GetRequiredService<IWebHostEnvironment>();
        var file = env.WebRootFileProvider.GetFileInfo("launch/index.html");
        if (file.Exists)
        {
            context.Response.ContentType = "text/html";
            await using var stream = file.CreateReadStream();
            await stream.CopyToAsync(context.Response.Body);
            return;
        }
    }
    if (path.Equals("/v1", StringComparison.OrdinalIgnoreCase) ||
        path.Equals("/v1/", StringComparison.OrdinalIgnoreCase))
    {
        var env = context.RequestServices.GetRequiredService<IWebHostEnvironment>();
        var file = env.WebRootFileProvider.GetFileInfo("v1/index.html");
        if (file.Exists)
        {
            context.Response.ContentType = "text/html";
            await using var stream = file.CreateReadStream();
            await stream.CopyToAsync(context.Response.Body);
            return;
        }
    }
    if (path.Equals("/v2", StringComparison.OrdinalIgnoreCase) ||
        path.Equals("/v2/", StringComparison.OrdinalIgnoreCase))
    {
        var env = context.RequestServices.GetRequiredService<IWebHostEnvironment>();
        var file = env.WebRootFileProvider.GetFileInfo("v2/index.html");
        if (file.Exists)
        {
            context.Response.ContentType = "text/html";
            await using var stream = file.CreateReadStream();
            await stream.CopyToAsync(context.Response.Body);
            return;
        }
    }
    if (path.Equals("/v2-Dashboard", StringComparison.OrdinalIgnoreCase) ||
        path.Equals("/v2-Dashboard/", StringComparison.OrdinalIgnoreCase))
    {
        var env = context.RequestServices.GetRequiredService<IWebHostEnvironment>();
        var file = env.WebRootFileProvider.GetFileInfo("v2-Dashboard/index.html");
        if (file.Exists)
        {
            context.Response.ContentType = "text/html";
            await using var stream = file.CreateReadStream();
            await stream.CopyToAsync(context.Response.Body);
            return;
        }
    }
    if (path.Equals("/v2-Control", StringComparison.OrdinalIgnoreCase) ||
        path.Equals("/v2-Control/", StringComparison.OrdinalIgnoreCase))
    {
        var env = context.RequestServices.GetRequiredService<IWebHostEnvironment>();
        var file = env.WebRootFileProvider.GetFileInfo("v2-Control/index.html");
        if (file.Exists)
        {
            context.Response.ContentType = "text/html";
            await using var stream = file.CreateReadStream();
            await stream.CopyToAsync(context.Response.Body);
            return;
        }
    }
    if (path.Equals("/v2-Codex", StringComparison.OrdinalIgnoreCase) ||
        path.Equals("/v2-Codex/", StringComparison.OrdinalIgnoreCase))
    {
        var env = context.RequestServices.GetRequiredService<IWebHostEnvironment>();
        var file = env.WebRootFileProvider.GetFileInfo("v2-Codex/index.html");
        if (file.Exists)
        {
            context.Response.ContentType = "text/html";
            await using var stream = file.CreateReadStream();
            await stream.CopyToAsync(context.Response.Body);
            return;
        }
    }
    if (path.Equals("/v2-Tactile", StringComparison.OrdinalIgnoreCase) ||
        path.Equals("/v2-Tactile/", StringComparison.OrdinalIgnoreCase))
    {
        var env = context.RequestServices.GetRequiredService<IWebHostEnvironment>();
        var file = env.WebRootFileProvider.GetFileInfo("v2-Tactile/index.html");
        if (file.Exists)
        {
            context.Response.ContentType = "text/html";
            await using var stream = file.CreateReadStream();
            await stream.CopyToAsync(context.Response.Body);
            return;
        }
    }
    if (path.Equals("/launch-neo", StringComparison.OrdinalIgnoreCase) ||
        path.Equals("/launch-neo/", StringComparison.OrdinalIgnoreCase))
    {
        var env = context.RequestServices.GetRequiredService<IWebHostEnvironment>();
        var file = env.WebRootFileProvider.GetFileInfo("launch-neo/index.html");
        if (file.Exists)
        {
            context.Response.ContentType = "text/html";
            await using var stream = file.CreateReadStream();
            await stream.CopyToAsync(context.Response.Body);
            return;
        }
    }
    await next();
});

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/state", (AudioControlService service) => Results.Ok(service.GetState()));
app.MapGet("/api/telemetry-state", (AudioControlService service) => Results.Ok(service.GetTelemetryState()));
app.MapGet("/api/events", async (HttpContext context, AudioControlService service) =>
{
    context.Response.Headers.ContentType = "text/event-stream";
    context.Response.Headers.CacheControl = "no-cache";
    context.Response.Headers.Connection = "keep-alive";

    var reader = service.Subscribe(context.RequestAborted);
    await foreach (var snapshot in reader.ReadAllAsync(context.RequestAborted))
    {
        var payload = JsonSerializer.Serialize(snapshot);
        await context.Response.WriteAsync($"event: state\ndata: {payload}\n\n", context.RequestAborted);
        await context.Response.Body.FlushAsync(context.RequestAborted);
    }
});
app.MapGet("/api/telemetry", async (HttpContext context, AudioControlService service) =>
{
    context.Response.Headers.ContentType = "text/event-stream";
    context.Response.Headers.CacheControl = "no-cache";
    context.Response.Headers.Connection = "keep-alive";

    var reader = service.SubscribeTelemetry(context.RequestAborted);
    await foreach (var snapshot in reader.ReadAllAsync(context.RequestAborted))
    {
        var payload = JsonSerializer.Serialize(snapshot);
        await context.Response.WriteAsync($"event: telemetry\ndata: {payload}\n\n", context.RequestAborted);
        await context.Response.Body.FlushAsync(context.RequestAborted);
    }
});
app.MapPost("/api/refresh-devices", (AudioControlService service) => ExecuteAsync(service.RefreshDevicesAsync));
app.MapPost("/api/open-config-folder", (AudioControlService service) => ExecuteAsync(service.OpenConfigFolderAsync));
app.MapPost("/api/start", (AudioControlService service) => ExecuteAsync(service.StartStreamingAsync));
app.MapPost("/api/stop", (AudioControlService service) => ExecuteAsync(service.StopStreamingAsync));
app.MapPost("/api/calibrate", (AudioControlService service) => ExecuteAsync(service.RunCalibrationAsync));
app.MapPost("/api/calibrate/cancel", (AudioControlService service) => ExecuteAsync(service.CancelCalibrationAsync));
app.MapPost("/api/outputs", (AudioControlService service) => ExecuteAsync(service.AddOutputAsync));
app.MapPost("/api/outputs/{slotIndex:int}/mute", (AudioControlService service, int slotIndex) => ExecuteAsync(() => service.ToggleMuteAsync(slotIndex)));
app.MapPost("/api/outputs/{slotIndex:int}/solo", (AudioControlService service, int slotIndex) => ExecuteAsync(() => service.ToggleSoloAsync(slotIndex)));
app.MapPost("/api/outputs/{slotIndex:int}/ping", (AudioControlService service, int slotIndex) => ExecuteAsync(() => service.PingOutputAsync(slotIndex)));
app.MapDelete("/api/outputs/{slotIndex:int}", (AudioControlService service, int slotIndex) => ExecuteAsync(() => service.RemoveOutputAsync(slotIndex)));
app.MapPut("/api/settings", (AudioControlService service, MainSettingsUpdateRequest request) => ExecuteAsync(() => service.UpdateSettingsAsync(request)));
app.MapPut("/api/outputs/{slotIndex:int}", (AudioControlService service, int slotIndex, OutputUpdateRequest request) => ExecuteAsync(() => service.UpdateOutputAsync(slotIndex, request)));
app.MapPut("/api/device-profiles", (AudioControlService service, DeviceProfileUpdateRequest request) => ExecuteAsync(() => service.UpdateDeviceProfileAsync(request)));

app.MapFallbackToFile("index.html");

app.Run();

static async Task<IResult> ExecuteAsync(Func<Task<AudioDashboardState>> action)
{
    try
    {
        return Results.Ok(await action());
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
}

static int ResolvePort()
{
    const int defaultPort = 5057;
    const int maxAttempts = 24;

    var configuredPort = Environment.GetEnvironmentVariable("MULTIAUDIO_WEBUI_PORT");
    if (!string.IsNullOrWhiteSpace(configuredPort) &&
        int.TryParse(configuredPort, out var parsedPort) &&
        parsedPort is >= 1024 and <= 65535)
    {
        return parsedPort;
    }

    for (var candidate = defaultPort; candidate < defaultPort + maxAttempts; candidate++)
    {
        if (IsTcpPortAvailable(candidate))
        {
            return candidate;
        }
    }

    return GetEphemeralPort();
}

static bool IsTcpPortAvailable(int port)
{
    TcpListener? ipv4Listener = null;
    TcpListener? ipv6Listener = null;

    try
    {
        ipv4Listener = new TcpListener(IPAddress.Loopback, port);
        ipv4Listener.Start();

        if (Socket.OSSupportsIPv6)
        {
            ipv6Listener = new TcpListener(IPAddress.IPv6Loopback, port);
            ipv6Listener.Server.DualMode = false;
            ipv6Listener.Start();
        }

        return true;
    }
    catch (SocketException)
    {
        return false;
    }
    finally
    {
        ipv4Listener?.Stop();
        ipv6Listener?.Stop();
    }
}

static int GetEphemeralPort()
{
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();

    try
    {
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
    finally
    {
        listener.Stop();
    }
}

static void TryOpenBrowser(string url)
{
    var disableBrowserLaunch = Environment.GetEnvironmentVariable("MULTIAUDIO_NO_BROWSER");
    if (string.Equals(disableBrowserLaunch, "1", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(disableBrowserLaunch, "true", StringComparison.OrdinalIgnoreCase))
    {
        return;
    }

    _ = Task.Run(async () =>
    {
        try
        {
            await Task.Delay(750);
            Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true
            });
        }
        catch
        {
            // Ignore browser-launch failures; the server is already running and the URL is printed.
        }
    });
}
