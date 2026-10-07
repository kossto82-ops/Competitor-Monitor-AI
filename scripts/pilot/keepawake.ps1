# Keeps Windows from sleeping because of inactivity while this process lives. It does not change any power
# setting: the request disappears when the process ends. A closed laptop lid still sleeps the machine.
Add-Type -Namespace Cma -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
[void][Cma.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
while ($true) { Start-Sleep -Seconds 60 }
