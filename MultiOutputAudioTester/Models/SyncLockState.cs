namespace MultiOutputAudioTester.Models;

public enum SyncLockState
{
    Disabled,
    WaitingForMic,
    Listening,
    Converging,
    Locked,
    LowConfidence,
    Faulted
}
