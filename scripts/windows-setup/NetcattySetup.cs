// Netcatty setup shell for Windows.
//
// A small borderless, dark, blurred-glass window that replaces the stock NSIS
// wizard. The real installer (the NSIS package electron-builder produces) is
// appended to this executable; the shell extracts it and runs it silently, so
// what gets installed, the shortcuts, the registry entries and the uninstaller
// are exactly the ones of the classic installer.
//
// Layout of the final file (written by scripts/build-windows-setup-shell.cjs):
//   [this exe][payload][meta utf-8][int64 payload length][int32 meta length]["NCSETUP1"]
//
// Compiled with the .NET Framework C# compiler, which every supported Windows
// ships, so keep the syntax at C# 5: no string interpolation, no ?. operator.
//
// Switches (used by CI, harmless for users):
//   --dir <path>        preselect the install folder
//   --auto              install without waiting for a click, exit when done
//   --log <file>        append progress lines to a file
//   --selftest <dir>    render every screen to PNG files and exit
//   --lang <culture>    force the language, e.g. zh-CN (default: system language)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;
using Ellipse = System.Windows.Shapes.Ellipse;
using ShapePath = System.Windows.Shapes.Path;

namespace NetcattySetup
{
    internal sealed class SetupOptions
    {
        public string Dir;
        public bool Auto;
        public string LogFile;
        public string SelfTestDir;
        public string Lang;
    }

    internal static class Log
    {
        public static string File;

        public static void Write(string line)
        {
            if (string.IsNullOrEmpty(File)) return;
            try
            {
                System.IO.File.AppendAllText(File, DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + line + Environment.NewLine);
            }
            catch (Exception) { }
        }
    }

    /// <summary>The NSIS installer and build facts appended to this executable.</summary>
    internal sealed class Payload
    {
        private const string Magic = "NCSETUP1";

        public string SelfPath;
        public long Offset;
        public long Length;
        public Dictionary<string, string> Meta = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public bool Present { get { return Length > 0; } }

        public string Get(string key, string fallback)
        {
            string value;
            return Meta.TryGetValue(key, out value) && !string.IsNullOrEmpty(value) ? value : fallback;
        }

        public long GetLong(string key, long fallback)
        {
            long value;
            return long.TryParse(Get(key, ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ? value : fallback;
        }

        public static Payload Read()
        {
            Payload payload = new Payload();
            payload.SelfPath = Assembly.GetExecutingAssembly().Location;
            try
            {
                using (FileStream stream = new FileStream(payload.SelfPath, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    const int footer = 8 + 4 + 8;
                    if (stream.Length < footer) return payload;
                    byte[] tail = new byte[footer];
                    stream.Seek(-footer, SeekOrigin.End);
                    ReadFully(stream, tail, footer);
                    if (Encoding.ASCII.GetString(tail, 12, 8) != Magic) return payload;
                    long payloadLength = BitConverter.ToInt64(tail, 0);
                    int metaLength = BitConverter.ToInt32(tail, 8);
                    long metaOffset = stream.Length - footer - metaLength;
                    long payloadOffset = metaOffset - payloadLength;
                    if (payloadLength <= 0 || metaLength < 0 || payloadOffset <= 0) return payload;
                    byte[] metaBytes = new byte[metaLength];
                    stream.Seek(metaOffset, SeekOrigin.Begin);
                    ReadFully(stream, metaBytes, metaLength);
                    foreach (string line in Encoding.UTF8.GetString(metaBytes).Split('\n'))
                    {
                        int eq = line.IndexOf('=');
                        if (eq > 0) payload.Meta[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
                    }
                    payload.Offset = payloadOffset;
                    payload.Length = payloadLength;
                }
            }
            catch (Exception error)
            {
                Log.Write("payload read failed: " + error.Message);
            }
            return payload;
        }

        private static void ReadFully(Stream stream, byte[] buffer, int count)
        {
            int done = 0;
            while (done < count)
            {
                int read = stream.Read(buffer, done, count - done);
                if (read <= 0) throw new EndOfStreamException();
                done += read;
            }
        }

        /// <summary>Copies the installer out of this executable. progress gets 0..1.</summary>
        public void ExtractTo(string target, Action<double> progress)
        {
            using (FileStream source = new FileStream(SelfPath, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (FileStream destination = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                source.Seek(Offset, SeekOrigin.Begin);
                byte[] buffer = new byte[1 << 20];
                long left = Length;
                while (left > 0)
                {
                    int read = source.Read(buffer, 0, (int)Math.Min(buffer.Length, left));
                    if (read <= 0) throw new EndOfStreamException();
                    destination.Write(buffer, 0, read);
                    left -= read;
                    if (progress != null) progress(1.0 - (double)left / Length);
                }
            }
        }
    }

    internal static class Strings
    {
        private static int Lang = Detect(CultureInfo.CurrentUICulture.Name);

        /// <summary>Overrides the language picked from the system (used by the screen renders).</summary>
        public static void Use(string cultureName)
        {
            Lang = Detect(cultureName);
        }

        private static int Detect(string cultureName)
        {
            string name = (cultureName ?? "").ToLowerInvariant();
            if (name.StartsWith("zh"))
            {
                if (name.Contains("hant") || name.EndsWith("-tw") || name.EndsWith("-hk") || name.EndsWith("-mo")) return 2;
                return 1;
            }
            return 0;
        }

        private static string Pick(string en, string hans, string hant)
        {
            return Lang == 1 ? hans : (Lang == 2 ? hant : en);
        }

        public static string WindowTitle { get { return Pick("Netcatty Setup", "Netcatty 安装", "Netcatty 安裝"); } }
        public static string Tagline { get { return Pick("SSH, terminal and SFTP in one place", "SSH、终端与 SFTP，一处搞定", "SSH、終端機與 SFTP，一處搞定"); } }
        public static string Version { get { return Pick("Version {0}", "版本 {0}", "版本 {0}"); } }
        public static string InstallTo { get { return Pick("Install to", "安装到", "安裝到"); } }
        public static string Change { get { return Pick("Change", "更改", "變更"); } }
        public static string Install { get { return Pick("Install", "安装", "安裝"); } }
        public static string Update { get { return Pick("Update", "更新", "更新"); } }
        public static string Preparing { get { return Pick("Preparing…", "正在准备…", "正在準備…"); } }
        public static string Installing { get { return Pick("Installing…", "正在安装…", "正在安裝…"); } }
        public static string Finishing { get { return Pick("Finishing up…", "即将完成…", "即將完成…"); } }
        public static string Done { get { return Pick("Netcatty is ready", "Netcatty 已安装完成", "Netcatty 已安裝完成"); } }
        public static string Launch { get { return Pick("Launch Netcatty", "启动 Netcatty", "啟動 Netcatty"); } }
        public static string Close { get { return Pick("Close", "关闭", "關閉"); } }
        public static string Failed { get { return Pick("Installation did not finish", "安装没有完成", "安裝沒有完成"); } }
        public static string Retry { get { return Pick("Try again", "重试", "重試"); } }
        public static string Classic { get { return Pick("Use the classic installer", "使用经典安装程序", "使用傳統安裝程式"); } }
        public static string ChooseFolder { get { return Pick("Choose where to install Netcatty", "选择 Netcatty 的安装位置", "選擇 Netcatty 的安裝位置"); } }
        public static string NoPayload { get { return Pick("This setup file is incomplete. Download it again.", "安装文件不完整，请重新下载。", "安裝檔不完整，請重新下載。"); } }
        public static string NotWritable { get { return Pick("Cannot write to this folder. Choose another one, or use the classic installer.", "无法写入这个文件夹。请换一个位置，或使用经典安装程序。", "無法寫入這個資料夾。請換一個位置，或使用傳統安裝程式。"); } }
        public static string ExitCode { get { return Pick("The installer stopped with code {0}.", "安装程序以代码 {0} 结束。", "安裝程式以代碼 {0} 結束。"); } }
        public static string CancelRunning { get { return Pick("Installation is still running.", "安装仍在进行中。", "安裝仍在進行中。"); } }
    }

    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct AccentPolicy
        {
            public int AccentState;
            public int AccentFlags;
            public uint GradientColor;
            public int AnimationId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WindowCompositionAttributeData
        {
            public int Attribute;
            public IntPtr Data;
            public int SizeOfData;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct OsVersionInfo
        {
            public int Size;
            public int Major;
            public int Minor;
            public int Build;
            public int Platform;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string ServicePack;
        }

        [DllImport("user32.dll")]
        private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        [DllImport("ntdll.dll")]
        private static extern int RtlGetVersion(ref OsVersionInfo info);

        public static int WindowsBuild()
        {
            try
            {
                OsVersionInfo info = new OsVersionInfo();
                info.Size = Marshal.SizeOf(typeof(OsVersionInfo));
                if (RtlGetVersion(ref info) == 0 && info.Major >= 10) return info.Build;
            }
            catch (Exception) { }
            return 0;
        }

        /// <summary>
        /// Blurs whatever is behind the window. Windows 11 gets acrylic; Windows 10
        /// gets the plain blur, because acrylic there makes dragging the window lag.
        /// Returns false when the system offers neither (the caller then paints an
        /// opaque background).
        /// </summary>
        public static bool EnableBlur(IntPtr hwnd, int build)
        {
            if (build < 10240) return false;
            try
            {
                AccentPolicy accent = new AccentPolicy();
                accent.AccentState = build >= 22000 ? 4 : 3;
                accent.AccentFlags = 2;
                // AABBGGRR: black at roughly 55% so the desktop only glows through.
                accent.GradientColor = 0x8C000000;
                int size = Marshal.SizeOf(accent);
                IntPtr pointer = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(accent, pointer, false);
                    WindowCompositionAttributeData data = new WindowCompositionAttributeData();
                    data.Attribute = 19;
                    data.Data = pointer;
                    data.SizeOfData = size;
                    return SetWindowCompositionAttribute(hwnd, ref data) != 0;
                }
                finally
                {
                    Marshal.FreeHGlobal(pointer);
                }
            }
            catch (Exception error)
            {
                Log.Write("blur unavailable: " + error.Message);
                return false;
            }
        }

        public static void RoundCorners(IntPtr hwnd, int build)
        {
            if (build < 22000) return;
            try
            {
                int round = 2;
                DwmSetWindowAttribute(hwnd, 33, ref round, sizeof(int));
            }
            catch (Exception) { }
        }
    }

    internal static class InstallLocator
    {
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";

        /// <summary>Folder of an existing Netcatty install, or null.</summary>
        public static string FindExisting(string productName)
        {
            foreach (RegistryKey root in new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                try
                {
                    using (RegistryKey uninstall = root.OpenSubKey(UninstallKey))
                    {
                        if (uninstall == null) continue;
                        foreach (string name in uninstall.GetSubKeyNames())
                        {
                            using (RegistryKey entry = uninstall.OpenSubKey(name))
                            {
                                if (entry == null) continue;
                                string display = entry.GetValue("DisplayName") as string;
                                if (display == null) continue;
                                if (display != productName && !display.StartsWith(productName + " ", StringComparison.OrdinalIgnoreCase)) continue;
                                string location = entry.GetValue("InstallLocation") as string;
                                if (string.IsNullOrEmpty(location)) location = FolderOf(entry.GetValue("DisplayIcon") as string);
                                if (string.IsNullOrEmpty(location)) location = FolderOf(entry.GetValue("UninstallString") as string);
                                if (!string.IsNullOrEmpty(location) && Directory.Exists(location)) return location.TrimEnd('\\');
                            }
                        }
                    }
                }
                catch (Exception) { }
            }
            return null;
        }

        /// <summary>Folder of the first .exe path in a registry value such as `"C:\x\App.exe",0`.</summary>
        private static string FolderOf(string value)
        {
            if (string.IsNullOrEmpty(value)) return null;
            try
            {
                string text = value.Trim();
                int end = text.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
                if (end < 0) return null;
                string exe = text.Substring(0, end + 4).Trim('"', ' ');
                return System.IO.Path.GetDirectoryName(exe);
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static string DefaultFor(string productName)
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return System.IO.Path.Combine(System.IO.Path.Combine(local, "Programs"), productName);
        }

        public static long DirectorySize(string dir)
        {
            long total = 0;
            try
            {
                if (!Directory.Exists(dir)) return 0;
                Stack<string> pending = new Stack<string>();
                pending.Push(dir);
                while (pending.Count > 0)
                {
                    string current = pending.Pop();
                    try
                    {
                        foreach (string file in Directory.GetFiles(current))
                        {
                            try { total += new FileInfo(file).Length; } catch (Exception) { }
                        }
                        foreach (string child in Directory.GetDirectories(current)) pending.Push(child);
                    }
                    catch (Exception) { }
                }
            }
            catch (Exception) { }
            return total;
        }

        public static bool CanWrite(string dir)
        {
            try
            {
                Directory.CreateDirectory(dir);
                string probe = System.IO.Path.Combine(dir, ".netcatty-setup-" + Guid.NewGuid().ToString("N"));
                System.IO.File.WriteAllText(probe, "");
                System.IO.File.Delete(probe);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    /// <summary>A flat rounded button drawn by hand so no theme resources are needed.</summary>
    internal sealed class FlatButton : Border
    {
        private readonly TextBlock label = new TextBlock();
        private readonly bool primary;
        private bool pressed;

        public event EventHandler Click;

        public FlatButton(string text, bool primary)
        {
            this.primary = primary;
            label.Text = text;
            label.FontSize = primary ? 15 : 13;
            label.FontWeight = primary ? FontWeights.SemiBold : FontWeights.Normal;
            label.HorizontalAlignment = HorizontalAlignment.Center;
            label.VerticalAlignment = VerticalAlignment.Center;
            Child = label;
            CornerRadius = new CornerRadius(primary ? 10 : 8);
            Padding = primary ? new Thickness(28, 0, 28, 0) : new Thickness(14, 0, 14, 0);
            Height = primary ? 44 : 32;
            Cursor = Cursors.Hand;
            SnapsToDevicePixels = true;
            Paint();
            MouseEnter += delegate { Paint(); };
            MouseLeave += delegate { pressed = false; Paint(); };
            MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e) { pressed = true; Paint(); e.Handled = true; };
            MouseLeftButtonUp += delegate(object sender, MouseButtonEventArgs e)
            {
                bool fire = pressed;
                pressed = false;
                Paint();
                e.Handled = true;
                if (fire) Raise();
            };
        }

        public string Text
        {
            get { return label.Text; }
            set { label.Text = value; }
        }

        public void Raise()
        {
            EventHandler handler = Click;
            if (handler != null && IsEnabled) handler(this, EventArgs.Empty);
        }

        private void Paint()
        {
            bool hover = IsMouseOver;
            if (primary)
            {
                byte shade = pressed ? (byte)0xD0 : (hover ? (byte)0xFF : (byte)0xF2);
                Background = new SolidColorBrush(Color.FromRgb(shade, shade, shade));
                label.Foreground = new SolidColorBrush(Color.FromRgb(0x0A, 0x0A, 0x0C));
                BorderThickness = new Thickness(0);
            }
            else
            {
                byte alpha = pressed ? (byte)0x40 : (hover ? (byte)0x2E : (byte)0x1A);
                Background = new SolidColorBrush(Color.FromArgb(alpha, 0xFF, 0xFF, 0xFF));
                label.Foreground = new SolidColorBrush(Color.FromArgb(0xE6, 0xFF, 0xFF, 0xFF));
                BorderBrush = new SolidColorBrush(Color.FromArgb(0x24, 0xFF, 0xFF, 0xFF));
                BorderThickness = new Thickness(1);
            }
        }
    }

    internal enum Screen { Welcome, Installing, Done, Failed }

    internal sealed class SetupWindow : Window
    {
        private const double WindowWidth = 720;
        private const double WindowHeight = 460;
        private const double BarWidth = 360;

        private readonly SetupOptions options;
        private readonly Payload payload;
        private readonly string productName;
        private readonly string exeName;
        private readonly string existingDir;

        private string installDir;
        private bool dirChosenByUser;
        private bool installing;
        private bool blurOn;
        private Screen screen = Screen.Welcome;
        private int exitCode;

        private Border chrome;
        private readonly StackPanel welcomePanel = new StackPanel();
        private readonly StackPanel installingPanel = new StackPanel();
        private readonly StackPanel donePanel = new StackPanel();
        private readonly StackPanel failedPanel = new StackPanel();
        private readonly TextBlock pathText = new TextBlock();
        private readonly TextBlock statusText = new TextBlock();
        private readonly TextBlock percentText = new TextBlock();
        private readonly TextBlock failedDetail = new TextBlock();
        private readonly Border barFill = new Border();
        private readonly TranslateTransform barShift = new TranslateTransform();
        private FlatButton installButton;
        private FlatButton launchButton;
        private FlatButton retryButton;

        public SetupWindow(SetupOptions options, Payload payload)
        {
            this.options = options;
            this.payload = payload;
            productName = payload.Get("productName", "Netcatty");
            exeName = payload.Get("exeName", productName + ".exe");
            existingDir = InstallLocator.FindExisting(productName);
            installDir = !string.IsNullOrEmpty(options.Dir) ? options.Dir : (existingDir ?? InstallLocator.DefaultFor(productName));
            dirChosenByUser = !string.IsNullOrEmpty(options.Dir);

            Title = Strings.WindowTitle;
            Width = WindowWidth;
            Height = WindowHeight;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            UseLayoutRounding = true;
            FontFamily = new FontFamily("Segoe UI Variable Display, Segoe UI, Microsoft YaHei UI, Microsoft JhengHei UI");
            Foreground = Brushes.White;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Ideal);
            ImageSource icon = LoadIcon(256);
            if (icon != null) Icon = icon;

            Content = BuildContent(icon);
            ShowScreen(Screen.Welcome);

            SourceInitialized += OnSourceInitialized;
            Loaded += OnLoaded;
            KeyDown += OnKeyDown;
            Closing += OnClosing;
            MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e)
            {
                if (e.ButtonState == MouseButtonState.Pressed)
                {
                    try { DragMove(); } catch (InvalidOperationException) { }
                }
            };
        }

        public int ExitCodeValue { get { return exitCode; } }

        private static ImageSource LoadIcon(int pixels)
        {
            try
            {
                Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("icon.png");
                if (stream == null) return null;
                BitmapImage image = new BitmapImage();
                image.BeginInit();
                image.StreamSource = stream;
                image.DecodePixelWidth = pixels;
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.EndInit();
                image.Freeze();
                return image;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private void OnSourceInitialized(object sender, EventArgs e)
        {
            IntPtr hwnd = new WindowInteropHelper(this).Handle;
            int build = Native.WindowsBuild();
            blurOn = Native.EnableBlur(hwnd, build);
            Native.RoundCorners(hwnd, build);
            PaintChrome();
            Log.Write("windows build " + build + ", blur " + (blurOn ? "on" : "off"));
        }

        /// <summary>
        /// With the blur on, a thin black veil keeps text readable over any
        /// wallpaper. Without it the window is simply near-opaque black.
        /// </summary>
        private void PaintChrome()
        {
            LinearGradientBrush veil = new LinearGradientBrush();
            veil.StartPoint = new Point(0, 0);
            veil.EndPoint = new Point(1, 1);
            byte top = blurOn ? (byte)0x59 : (byte)0xF7;
            byte bottom = blurOn ? (byte)0x8C : (byte)0xFC;
            veil.GradientStops.Add(new GradientStop(Color.FromArgb(top, 0x14, 0x14, 0x18), 0));
            veil.GradientStops.Add(new GradientStop(Color.FromArgb(bottom, 0x00, 0x00, 0x00), 1));
            chrome.Background = veil;
        }

        private UIElement BuildContent(ImageSource icon)
        {
            chrome = new Border();
            chrome.BorderBrush = new SolidColorBrush(Color.FromArgb(0x29, 0xFF, 0xFF, 0xFF));
            chrome.BorderThickness = new Thickness(1);
            chrome.SnapsToDevicePixels = true;

            Grid root = new Grid();
            root.ClipToBounds = true;
            chrome.Child = root;

            // A soft glow behind the icon gives the glass some depth.
            Ellipse glow = new Ellipse();
            glow.Width = 520;
            glow.Height = 520;
            glow.HorizontalAlignment = HorizontalAlignment.Center;
            glow.VerticalAlignment = VerticalAlignment.Top;
            glow.Margin = new Thickness(0, -250, 0, 0);
            glow.IsHitTestVisible = false;
            RadialGradientBrush glowBrush = new RadialGradientBrush();
            glowBrush.GradientStops.Add(new GradientStop(Color.FromArgb(0x38, 0x5B, 0x8C, 0xFF), 0));
            glowBrush.GradientStops.Add(new GradientStop(Color.FromArgb(0x00, 0x5B, 0x8C, 0xFF), 1));
            glow.Fill = glowBrush;
            root.Children.Add(glow);

            Border close = new Border();
            close.Width = 46;
            close.Height = 34;
            close.HorizontalAlignment = HorizontalAlignment.Right;
            close.VerticalAlignment = VerticalAlignment.Top;
            close.Background = Brushes.Transparent;
            close.ToolTip = Strings.Close;
            ShapePath cross = new ShapePath();
            cross.Data = Geometry.Parse("M0,0 L10,10 M10,0 L0,10");
            cross.Stroke = new SolidColorBrush(Color.FromArgb(0xCC, 0xFF, 0xFF, 0xFF));
            cross.StrokeThickness = 1.2;
            cross.Width = 10;
            cross.Height = 10;
            cross.HorizontalAlignment = HorizontalAlignment.Center;
            cross.VerticalAlignment = VerticalAlignment.Center;
            close.Child = cross;
            close.MouseEnter += delegate { close.Background = new SolidColorBrush(Color.FromRgb(0xC4, 0x2B, 0x1C)); };
            close.MouseLeave += delegate { close.Background = Brushes.Transparent; };
            close.MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e) { e.Handled = true; };
            close.MouseLeftButtonUp += delegate(object sender, MouseButtonEventArgs e) { e.Handled = true; Close(); };
            root.Children.Add(close);

            StackPanel column = new StackPanel();
            column.HorizontalAlignment = HorizontalAlignment.Center;
            column.VerticalAlignment = VerticalAlignment.Top;
            column.Margin = new Thickness(0, 56, 0, 0);
            root.Children.Add(column);

            if (icon != null)
            {
                Image image = new Image();
                image.Source = icon;
                image.Width = 96;
                image.Height = 96;
                image.HorizontalAlignment = HorizontalAlignment.Center;
                RenderOptions.SetBitmapScalingMode(image, BitmapScalingMode.HighQuality);
                column.Children.Add(image);
            }

            TextBlock name = new TextBlock();
            name.Text = productName;
            name.FontSize = 30;
            name.FontWeight = FontWeights.SemiBold;
            name.HorizontalAlignment = HorizontalAlignment.Center;
            name.Margin = new Thickness(0, 18, 0, 0);
            column.Children.Add(name);

            TextBlock tagline = new TextBlock();
            tagline.Text = Strings.Tagline;
            tagline.FontSize = 13;
            tagline.Foreground = new SolidColorBrush(Color.FromArgb(0x99, 0xFF, 0xFF, 0xFF));
            tagline.HorizontalAlignment = HorizontalAlignment.Center;
            tagline.Margin = new Thickness(0, 6, 0, 0);
            column.Children.Add(tagline);

            Grid stage = new Grid();
            stage.Width = 520;
            stage.Height = 150;
            stage.Margin = new Thickness(0, 30, 0, 0);
            column.Children.Add(stage);

            BuildWelcome();
            BuildInstalling();
            BuildDone();
            BuildFailed();
            stage.Children.Add(welcomePanel);
            stage.Children.Add(installingPanel);
            stage.Children.Add(donePanel);
            stage.Children.Add(failedPanel);

            TextBlock version = new TextBlock();
            version.Text = string.Format(CultureInfo.CurrentCulture, Strings.Version, payload.Get("version", "dev"));
            version.FontSize = 11;
            version.Foreground = new SolidColorBrush(Color.FromArgb(0x66, 0xFF, 0xFF, 0xFF));
            version.HorizontalAlignment = HorizontalAlignment.Center;
            version.VerticalAlignment = VerticalAlignment.Bottom;
            version.Margin = new Thickness(0, 0, 0, 16);
            root.Children.Add(version);

            return chrome;
        }

        private void BuildWelcome()
        {
            welcomePanel.HorizontalAlignment = HorizontalAlignment.Center;

            Border pathRow = new Border();
            pathRow.Width = 460;
            pathRow.Height = 40;
            pathRow.CornerRadius = new CornerRadius(10);
            pathRow.Background = new SolidColorBrush(Color.FromArgb(0x14, 0xFF, 0xFF, 0xFF));
            pathRow.BorderBrush = new SolidColorBrush(Color.FromArgb(0x1F, 0xFF, 0xFF, 0xFF));
            pathRow.BorderThickness = new Thickness(1);
            DockPanel dock = new DockPanel();
            dock.LastChildFill = true;
            pathRow.Child = dock;

            TextBlock caption = new TextBlock();
            caption.Text = Strings.InstallTo;
            caption.FontSize = 12;
            caption.Foreground = new SolidColorBrush(Color.FromArgb(0x80, 0xFF, 0xFF, 0xFF));
            caption.VerticalAlignment = VerticalAlignment.Center;
            caption.Margin = new Thickness(14, 0, 10, 0);
            DockPanel.SetDock(caption, Dock.Left);
            dock.Children.Add(caption);

            FlatButton change = new FlatButton(Strings.Change, false);
            change.Height = 28;
            change.Margin = new Thickness(8, 0, 6, 0);
            change.VerticalAlignment = VerticalAlignment.Center;
            change.Click += delegate { ChooseFolder(); };
            DockPanel.SetDock(change, Dock.Right);
            dock.Children.Add(change);

            pathText.FontSize = 12.5;
            pathText.Foreground = new SolidColorBrush(Color.FromArgb(0xE6, 0xFF, 0xFF, 0xFF));
            pathText.VerticalAlignment = VerticalAlignment.Center;
            pathText.TextTrimming = TextTrimming.CharacterEllipsis;
            ShowInstallDir();
            dock.Children.Add(pathText);

            welcomePanel.Children.Add(pathRow);

            installButton = new FlatButton(existingDir != null ? Strings.Update : Strings.Install, true);
            installButton.Width = 220;
            installButton.HorizontalAlignment = HorizontalAlignment.Center;
            installButton.Margin = new Thickness(0, 26, 0, 0);
            installButton.Click += delegate { StartInstall(false); };
            welcomePanel.Children.Add(installButton);
        }

        private void BuildInstalling()
        {
            installingPanel.HorizontalAlignment = HorizontalAlignment.Center;
            installingPanel.Margin = new Thickness(0, 22, 0, 0);

            Border track = new Border();
            track.Width = BarWidth;
            track.Height = 4;
            track.CornerRadius = new CornerRadius(2);
            track.Background = new SolidColorBrush(Color.FromArgb(0x26, 0xFF, 0xFF, 0xFF));
            track.ClipToBounds = true;
            barFill.Height = 4;
            barFill.Width = 0;
            barFill.CornerRadius = new CornerRadius(2);
            barFill.HorizontalAlignment = HorizontalAlignment.Left;
            barFill.Background = Brushes.White;
            barFill.RenderTransform = barShift;
            track.Child = barFill;
            installingPanel.Children.Add(track);

            Grid line = new Grid();
            line.Width = BarWidth;
            line.Margin = new Thickness(0, 14, 0, 0);
            statusText.FontSize = 13;
            statusText.Foreground = new SolidColorBrush(Color.FromArgb(0xB3, 0xFF, 0xFF, 0xFF));
            statusText.HorizontalAlignment = HorizontalAlignment.Left;
            percentText.FontSize = 13;
            percentText.Foreground = new SolidColorBrush(Color.FromArgb(0x80, 0xFF, 0xFF, 0xFF));
            percentText.HorizontalAlignment = HorizontalAlignment.Right;
            line.Children.Add(statusText);
            line.Children.Add(percentText);
            installingPanel.Children.Add(line);
        }

        private void BuildDone()
        {
            donePanel.HorizontalAlignment = HorizontalAlignment.Center;

            TextBlock message = new TextBlock();
            message.Text = Strings.Done;
            message.FontSize = 15;
            message.Foreground = new SolidColorBrush(Color.FromArgb(0xE6, 0xFF, 0xFF, 0xFF));
            message.HorizontalAlignment = HorizontalAlignment.Center;
            message.Margin = new Thickness(0, 8, 0, 0);
            donePanel.Children.Add(message);

            launchButton = new FlatButton(Strings.Launch, true);
            launchButton.Width = 220;
            launchButton.HorizontalAlignment = HorizontalAlignment.Center;
            launchButton.Margin = new Thickness(0, 26, 0, 0);
            launchButton.Click += delegate { LaunchApp(); };
            donePanel.Children.Add(launchButton);
        }

        private void BuildFailed()
        {
            failedPanel.HorizontalAlignment = HorizontalAlignment.Center;

            TextBlock headline = new TextBlock();
            headline.Text = Strings.Failed;
            headline.FontSize = 15;
            headline.Foreground = new SolidColorBrush(Color.FromRgb(0xFF, 0x9A, 0x8A));
            headline.HorizontalAlignment = HorizontalAlignment.Center;
            failedPanel.Children.Add(headline);

            failedDetail.FontSize = 12.5;
            failedDetail.Foreground = new SolidColorBrush(Color.FromArgb(0x99, 0xFF, 0xFF, 0xFF));
            failedDetail.HorizontalAlignment = HorizontalAlignment.Center;
            failedDetail.TextAlignment = TextAlignment.Center;
            failedDetail.TextWrapping = TextWrapping.Wrap;
            failedDetail.MaxWidth = 460;
            failedDetail.Margin = new Thickness(0, 8, 0, 0);
            failedPanel.Children.Add(failedDetail);

            StackPanel row = new StackPanel();
            row.Orientation = Orientation.Horizontal;
            row.HorizontalAlignment = HorizontalAlignment.Center;
            row.Margin = new Thickness(0, 22, 0, 0);
            retryButton = new FlatButton(Strings.Retry, false);
            retryButton.Click += delegate { ShowScreen(Screen.Welcome); };
            FlatButton classic = new FlatButton(Strings.Classic, false);
            classic.Margin = new Thickness(10, 0, 0, 0);
            classic.Click += delegate { StartInstall(true); };
            row.Children.Add(retryButton);
            row.Children.Add(classic);
            failedPanel.Children.Add(row);
        }

        internal void ShowScreen(Screen next)
        {
            screen = next;
            welcomePanel.Visibility = next == Screen.Welcome ? Visibility.Visible : Visibility.Collapsed;
            installingPanel.Visibility = next == Screen.Installing ? Visibility.Visible : Visibility.Collapsed;
            donePanel.Visibility = next == Screen.Done ? Visibility.Visible : Visibility.Collapsed;
            failedPanel.Visibility = next == Screen.Failed ? Visibility.Visible : Visibility.Collapsed;
            UIElement shown = next == Screen.Welcome ? welcomePanel
                : next == Screen.Installing ? installingPanel
                : next == Screen.Done ? (UIElement)donePanel : failedPanel;
            if (options.SelfTestDir == null)
            {
                shown.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(220)));
            }
        }

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            if (options.SelfTestDir != null)
            {
                Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(RunSelfTest));
                return;
            }
            if (!payload.Present)
            {
                Fail(Strings.NoPayload);
                return;
            }
            if (options.Auto) StartInstall(false);
        }

        private void OnKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Escape)
            {
                Close();
            }
            else if (e.Key == Key.Enter)
            {
                if (screen == Screen.Welcome) installButton.Raise();
                else if (screen == Screen.Done) launchButton.Raise();
                else if (screen == Screen.Failed) retryButton.Raise();
            }
        }

        private void OnClosing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            // The silent installer cannot be stopped halfway without leaving a
            // broken install, so the window stays until it has finished.
            if (installing)
            {
                e.Cancel = true;
                statusText.Text = Strings.CancelRunning;
            }
        }

        private void ChooseFolder()
        {
            using (System.Windows.Forms.FolderBrowserDialog dialog = new System.Windows.Forms.FolderBrowserDialog())
            {
                dialog.Description = Strings.ChooseFolder;
                dialog.ShowNewFolderButton = true;
                try
                {
                    string start = installDir;
                    while (!string.IsNullOrEmpty(start) && !Directory.Exists(start)) start = System.IO.Path.GetDirectoryName(start);
                    if (!string.IsNullOrEmpty(start)) dialog.SelectedPath = start;
                }
                catch (Exception) { }
                if (dialog.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;
                string chosen = dialog.SelectedPath.TrimEnd('\\');
                // Never unpack straight into a folder the user keeps other things in.
                if (!string.Equals(System.IO.Path.GetFileName(chosen), productName, StringComparison.OrdinalIgnoreCase))
                {
                    chosen = System.IO.Path.Combine(chosen, productName);
                }
                installDir = chosen;
                dirChosenByUser = true;
                ShowInstallDir();
            }
        }

        /// <summary>
        /// Long paths are shortened in the middle: the drive and the last folders
        /// say where the app goes, the user profile part in between does not.
        /// </summary>
        internal static string ShortenPath(string path, int max)
        {
            if (string.IsNullOrEmpty(path) || path.Length <= max) return path;
            int head = Math.Min(path.Length, Math.Max(3, max / 4));
            int separator = path.LastIndexOf('\\', head - 1);
            if (separator >= 2) head = separator + 1;
            int tail = max - head - 1;
            int cut = path.IndexOf('\\', path.Length - tail);
            if (cut > 0 && cut < path.Length - 1) tail = path.Length - cut;
            return path.Substring(0, head) + "\u2026" + path.Substring(path.Length - tail);
        }

        private void ShowInstallDir()
        {
            pathText.Text = ShortenPath(installDir, 44);
            pathText.ToolTip = installDir;
        }

        private void SetProgress(double fraction, string status)
        {
            barFill.BeginAnimation(WidthProperty, null);
            barShift.BeginAnimation(TranslateTransform.XProperty, null);
            barShift.X = 0;
            double clamped = Math.Max(0, Math.Min(1, fraction));
            barFill.Width = BarWidth * clamped;
            percentText.Text = ((int)Math.Round(clamped * 100)).ToString(CultureInfo.InvariantCulture) + "%";
            statusText.Text = status;
        }

        private void SetIndeterminate(string status)
        {
            statusText.Text = status;
            percentText.Text = "";
            barFill.Width = BarWidth * 0.3;
            DoubleAnimation slide = new DoubleAnimation(-BarWidth * 0.3, BarWidth, TimeSpan.FromMilliseconds(1300));
            slide.RepeatBehavior = RepeatBehavior.Forever;
            barShift.BeginAnimation(TranslateTransform.XProperty, slide);
        }

        private void Fail(string detail)
        {
            Log.Write("failed: " + detail);
            installing = false;
            exitCode = 1;
            failedDetail.Text = detail;
            ShowScreen(Screen.Failed);
            if (options.Auto) Close();
        }

        private void StartInstall(bool classic)
        {
            if (installing) return;
            if (!payload.Present)
            {
                Fail(Strings.NoPayload);
                return;
            }
            // An existing install is replaced in place by the installer itself;
            // only a folder the user picked needs to be checked and passed on.
            bool passDir = dirChosenByUser && !string.Equals(installDir, existingDir, StringComparison.OrdinalIgnoreCase);
            if (!classic && passDir && !InstallLocator.CanWrite(installDir))
            {
                Fail(Strings.NotWritable);
                return;
            }
            installing = true;
            exitCode = 0;
            ShowScreen(Screen.Installing);
            SetProgress(0, Strings.Preparing);
            string dir = installDir;
            Thread worker = new Thread(delegate() { InstallWorker(classic, passDir, dir); });
            worker.IsBackground = true;
            worker.Start();
        }

        private void Ui(Action action)
        {
            Dispatcher.BeginInvoke(DispatcherPriority.Normal, action);
        }

        private void InstallWorker(bool classic, bool passDir, string dir)
        {
            string tempDir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "NetcattySetup-" + Guid.NewGuid().ToString("N"));
            string installer = System.IO.Path.Combine(tempDir, productName + "-Installer.exe");
            try
            {
                Directory.CreateDirectory(tempDir);
                int lastShown = -1;
                payload.ExtractTo(installer, delegate(double fraction)
                {
                    int shown = (int)(fraction * 20);
                    if (shown == lastShown) return;
                    lastShown = shown;
                    double value = fraction * 0.2;
                    Ui(delegate { SetProgress(value, Strings.Preparing); });
                });
                Log.Write("extracted installer to " + installer);

                // /D= must come last and is taken literally to the end of the
                // line, so the path is not quoted even when it contains spaces.
                string arguments = classic ? "" : "/S";
                if (passDir) arguments += (arguments.Length > 0 ? " " : "") + "/D=" + dir;
                ProcessStartInfo start = new ProcessStartInfo(installer, arguments);
                start.UseShellExecute = false;
                start.WorkingDirectory = tempDir;
                Log.Write("running installer " + arguments);

                bool hadFiles = InstallLocator.DirectorySize(dir) > 0;
                long expected = Math.Max(1, payload.GetLong("unpackedBytes", 0));
                bool measurable = !classic && !hadFiles && payload.GetLong("unpackedBytes", 0) > 0;
                if (classic) Ui(delegate { WindowState = WindowState.Minimized; });
                if (!measurable) Ui(delegate { SetIndeterminate(Strings.Installing); });

                using (Process process = Process.Start(start))
                {
                    double best = 0.2;
                    while (!process.WaitForExit(600))
                    {
                        if (!measurable) continue;
                        double done = (double)InstallLocator.DirectorySize(dir) / expected;
                        double value = 0.2 + Math.Min(1.0, done) * 0.78;
                        if (value <= best) continue;
                        best = value;
                        string status = value > 0.95 ? Strings.Finishing : Strings.Installing;
                        Ui(delegate { SetProgress(value, status); });
                    }
                    int code = process.ExitCode;
                    Log.Write("installer exited with " + code);
                    string target = dir;
                    if (!System.IO.File.Exists(System.IO.Path.Combine(target, exeName)))
                    {
                        string registered = InstallLocator.FindExisting(productName);
                        if (registered != null) target = registered;
                    }
                    bool installed = System.IO.File.Exists(System.IO.Path.Combine(target, exeName));
                    Ui(delegate
                    {
                        if (classic) WindowState = WindowState.Normal;
                        installing = false;
                        if (code == 0 && installed)
                        {
                            installDir = target;
                            SetProgress(1, Strings.Finishing);
                            Log.Write("installed to " + target);
                            ShowScreen(Screen.Done);
                            if (options.Auto) Close();
                        }
                        else if (classic && code != 0)
                        {
                            // The classic wizard was cancelled by the user.
                            ShowScreen(Screen.Welcome);
                        }
                        else
                        {
                            Fail(string.Format(CultureInfo.CurrentCulture, Strings.ExitCode, code));
                        }
                    });
                }
            }
            catch (Exception error)
            {
                string message = error.Message;
                Ui(delegate
                {
                    if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
                    Fail(message);
                });
            }
            finally
            {
                try { Directory.Delete(tempDir, true); } catch (Exception) { }
            }
        }

        private void LaunchApp()
        {
            try
            {
                string exe = System.IO.Path.Combine(installDir, exeName);
                ProcessStartInfo start = new ProcessStartInfo(exe);
                start.WorkingDirectory = installDir;
                start.UseShellExecute = true;
                Process.Start(start);
            }
            catch (Exception error)
            {
                Log.Write("launch failed: " + error.Message);
            }
            Close();
        }

        // ---- CI self test -------------------------------------------------

        private void RunSelfTest()
        {
            try
            {
                Directory.CreateDirectory(options.SelfTestDir);
                // The real screen shows what the system compositor does with the
                // blur; the renders show the layout even on a headless session.
                Thread.Sleep(600);
                Shoot("welcome");
                ShowScreen(Screen.Installing);
                SetProgress(0.42, Strings.Installing);
                Shoot("installing");
                ShowScreen(Screen.Done);
                Shoot("done");
                failedDetail.Text = string.Format(CultureInfo.CurrentCulture, Strings.ExitCode, 2);
                ShowScreen(Screen.Failed);
                Shoot("failed");
                exitCode = 0;
            }
            catch (Exception error)
            {
                Log.Write("selftest failed: " + error);
                exitCode = 3;
            }
            Close();
        }

        private void Shoot(string name)
        {
            RenderTo(name + ".png");
            Thread.Sleep(150);
            CaptureScreen(System.IO.Path.Combine(options.SelfTestDir, "screen-" + name + ".png"));
        }

        private void Flush()
        {
            Dispatcher.Invoke(DispatcherPriority.ApplicationIdle, new Action(delegate { }));
        }

        /// <summary>Renders the window over a stand-in wallpaper so the glass tint is visible.</summary>
        private void RenderTo(string fileName)
        {
            Flush();
            UpdateLayout();
            int width = (int)WindowWidth;
            int height = (int)WindowHeight;
            DrawingVisual visual = new DrawingVisual();
            using (DrawingContext context = visual.RenderOpen())
            {
                LinearGradientBrush wallpaper = new LinearGradientBrush(Color.FromRgb(0x2B, 0x4A, 0x7A), Color.FromRgb(0x6B, 0x3A, 0x6E), 35);
                context.DrawRectangle(wallpaper, null, new Rect(0, 0, width, height));
                // What the system blur adds on a real desktop.
                context.DrawRectangle(new SolidColorBrush(Color.FromArgb(0x8C, 0, 0, 0)), null, new Rect(0, 0, width, height));
                VisualBrush window = new VisualBrush(chrome);
                window.Stretch = Stretch.None;
                window.ViewboxUnits = BrushMappingMode.Absolute;
                window.Viewbox = new Rect(0, 0, width, height);
                context.DrawRectangle(window, null, new Rect(0, 0, width, height));
            }
            RenderTargetBitmap bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
            bitmap.Render(visual);
            SavePng(bitmap, System.IO.Path.Combine(options.SelfTestDir, fileName));
        }

        private void CaptureScreen(string file)
        {
            try
            {
                Flush();
                Point origin = PointToScreen(new Point(0, 0));
                Point corner = PointToScreen(new Point(ActualWidth, ActualHeight));
                int width = (int)(corner.X - origin.X);
                int height = (int)(corner.Y - origin.Y);
                using (System.Drawing.Bitmap bitmap = new System.Drawing.Bitmap(width, height))
                {
                    using (System.Drawing.Graphics graphics = System.Drawing.Graphics.FromImage(bitmap))
                    {
                        graphics.CopyFromScreen((int)origin.X, (int)origin.Y, 0, 0, new System.Drawing.Size(width, height));
                    }
                    bitmap.Save(file, System.Drawing.Imaging.ImageFormat.Png);
                }
            }
            catch (Exception error)
            {
                Log.Write("screen capture unavailable: " + error.Message);
            }
        }

        private static void SavePng(BitmapSource bitmap, string file)
        {
            PngBitmapEncoder encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using (FileStream stream = new FileStream(file, FileMode.Create))
            {
                encoder.Save(stream);
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            SetupOptions options = new SetupOptions();
            for (int index = 0; index < args.Length; index += 1)
            {
                string arg = args[index];
                string next = index + 1 < args.Length ? args[index + 1] : null;
                if (arg == "--auto") options.Auto = true;
                else if (arg == "--dir" && next != null) { options.Dir = next.TrimEnd('\\'); index += 1; }
                else if (arg == "--log" && next != null) { options.LogFile = next; index += 1; }
                else if (arg == "--selftest" && next != null) { options.SelfTestDir = next; index += 1; }
                else if (arg == "--lang" && next != null) { options.Lang = next; index += 1; }
            }
            Log.File = options.LogFile;
            if (options.Lang != null) Strings.Use(options.Lang);
            Log.Write("setup shell started");
            try
            {
                Payload payload = Payload.Read();
                Log.Write("payload " + (payload.Present ? payload.Length + " bytes, version " + payload.Get("version", "?") : "missing"));
                Application app = new Application();
                app.ShutdownMode = ShutdownMode.OnMainWindowClose;
                SetupWindow window = new SetupWindow(options, payload);
                app.Run(window);
                Log.Write("exit " + window.ExitCodeValue);
                return window.ExitCodeValue;
            }
            catch (Exception error)
            {
                Log.Write("fatal: " + error);
                return 10;
            }
        }
    }
}
