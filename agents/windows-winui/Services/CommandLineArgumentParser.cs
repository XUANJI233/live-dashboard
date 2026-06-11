namespace LiveDashboardAgent.Services;

internal static class CommandLineArgumentParser
{
    public static string[] Parse(string? arguments)
    {
        if (string.IsNullOrWhiteSpace(arguments))
        {
            return [];
        }

        var parsed = new List<string>();
        var current = new List<char>();
        var inQuotes = false;
        foreach (var ch in arguments)
        {
            if (ch == '"')
            {
                inQuotes = !inQuotes;
                continue;
            }
            if (char.IsWhiteSpace(ch) && !inQuotes)
            {
                FlushCurrent(parsed, current);
                continue;
            }
            current.Add(ch);
        }
        FlushCurrent(parsed, current);
        return parsed.ToArray();
    }

    private static void FlushCurrent(List<string> parsed, List<char> current)
    {
        if (current.Count == 0)
        {
            return;
        }
        parsed.Add(new string(current.ToArray()));
        current.Clear();
    }
}
