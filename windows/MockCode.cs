// Test-only CLI sentinel. Never opens a window; a fallback is observable even
// when the real VS Code is installed and running on the test machine.
using System;
internal static class MockCode {
    private static int Main() {
        Console.Error.WriteLine("EXPECTED_TEST_CLI_FALLBACK");
        return 73;
    }
}
