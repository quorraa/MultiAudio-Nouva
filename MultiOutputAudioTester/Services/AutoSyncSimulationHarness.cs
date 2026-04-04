namespace MultiOutputAudioTester.Services;

public static class AutoSyncSimulationHarness
{
    public static string RunBasicScenario()
    {
        var routes = new[]
        {
            new SimulatedRoute(120.0, 0.0000, true),
            new SimulatedRoute(220.0, 0.0200, false),
            new SimulatedRoute(380.0, -0.0150, false)
        };

        var filtered = new double[routes.Length];
        var autoDelay = new double[routes.Length];
        var autoRate = Enumerable.Repeat(1.0, routes.Length).ToArray();

        for (var index = 0; index < routes.Length; index++)
        {
            filtered[index] = routes[index].ArrivalMilliseconds;
        }

        var lastResidual = 0.0;
        for (var step = 0; step < 160; step++)
        {
            for (var index = 0; index < routes.Length; index++)
            {
                routes[index].ArrivalMilliseconds += routes[index].DriftMillisecondsPerTick;
                filtered[index] += (routes[index].ArrivalMilliseconds - filtered[index]) * 0.18;
            }

            var target = filtered.Max();
            for (var index = 0; index < routes.Length; index++)
            {
                autoDelay[index] += Math.Clamp(target - filtered[index] - autoDelay[index], -2.0, 6.0);

                if (!routes[index].IsMaster)
                {
                    var alignedArrival = filtered[index] + autoDelay[index];
                    var residual = alignedArrival - target;
                    autoRate[index] += Math.Clamp(-residual * 0.00003, -0.00012, 0.00012);
                    autoRate[index] = Math.Clamp(autoRate[index], 1.0 - 0.0015, 1.0 + 0.0015);
                    routes[index].ArrivalMilliseconds -= (autoRate[index] - 1.0) * 40.0;
                    lastResidual = Math.Max(lastResidual, Math.Abs(residual));
                }
            }
        }

        return $"Auto-sync harness residual={lastResidual:F1} ms after simulated convergence.";
    }

    private sealed class SimulatedRoute
    {
        public SimulatedRoute(double arrivalMilliseconds, double driftMillisecondsPerTick, bool isMaster)
        {
            ArrivalMilliseconds = arrivalMilliseconds;
            DriftMillisecondsPerTick = driftMillisecondsPerTick;
            IsMaster = isMaster;
        }

        public double ArrivalMilliseconds { get; set; }

        public double DriftMillisecondsPerTick { get; }

        public bool IsMaster { get; }
    }
}
