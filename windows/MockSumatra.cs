// Test-only Windows argument receiver. It never opens a PDF or window.
using System;
using System.IO;
using System.Web.Script.Serialization;
internal static class MockSumatra {
    private static int Main(string[] args) {
        string log = Environment.GetEnvironmentVariable("TYPST_SUMATRA_TEST_LOG");
        if (String.IsNullOrEmpty(log)) return 1;
        File.WriteAllText(log, new JavaScriptSerializer().Serialize(args));
        return 0;
    }
}
