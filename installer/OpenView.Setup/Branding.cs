using System.Reflection;

namespace OpenView.Setup;

internal static class Branding
{
    private static readonly Lazy<Image> LoadedLogo = new(() =>
    {
        using var stream = OpenResource("logo.png");
        using var source = Image.FromStream(stream);
        return new Bitmap(source);
    });

    internal static Image Logo => LoadedLogo.Value;

    internal static Icon CreateIcon()
    {
        using var stream = OpenResource("icon.ico");
        using var icon = new Icon(stream, 32, 32);
        return (Icon)icon.Clone();
    }

    private static Stream OpenResource(string name) =>
        Assembly.GetExecutingAssembly().GetManifestResourceStream("OpenView.Setup." + name)
        ?? throw new InvalidOperationException("The OpenView branding resource is missing.");
}
