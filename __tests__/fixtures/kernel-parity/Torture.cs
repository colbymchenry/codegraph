#define TORTURE_FLAG
global using GlobalNs.Thing;
using System;
using System.Collections.Generic;
using static System.Math;

namespace Torture.Alpha
{
    using System.Text;

    namespace Inner
    {
        public class Deep { }
    }

    /// <summary>Doc line.</summary>
    /// <remarks>Second doc line over an attribute.</remarks>
    [Serializable]
    public class TortureClass : Widget
    {
#pragma warning disable 168
        public const int MaxItems = 10;
        public static readonly string DefaultName = "x";
        private const int LOCAL_SHADOWED = 5;
        private Widget A, B;
        private readonly int _count;
        private static int counter;
        private IRepo _repo;
        private ServiceCollection builder;
        private int status;
        private List<Action<int>> Table = new() { TargetCb };

#nullable enable
        public string Name { get; set; }
        public Widget Parent { get; init; }
        public List<Widget> Items { get; }
        public int Computed => MaxItems + 1;
        public Widget Made { get; } = new();
        public int Accessored { get { return Lookup(1); } set { Store(value); } }
        public Action A2 { get; } = () => Register(HandleThing);

        public event Action Changed;
        public event Action Custom
        {
            add { Register(HandleThing); }
            remove { Unregister(value); }
        }

        public static TortureClass operator +(TortureClass a, TortureClass b) { return Combine(a, b); }
        public static explicit operator int(TortureClass t) { return Score(t); }
        public int this[int idx] { get { return Lookup(idx); } }
        ~TortureClass() { Cleanup(); }

        public TortureClass(int seed) : base(Compute(seed)) { Init(seed); }
        public TortureClass() => Init(0);

        void IDisposable.Dispose() { Cleanup(); }

        protected internal void PI() { }
        private protected void PP() { }

        public async Task Waity() { await Task.Delay(1); }

        public int Sum() => Compute(1) + 2;

        private void HandleThing(int v) { }
        private static void StaticHandler() { }
        private void OnClick() { }
        private void Handler() { }
        private static void TargetCb(int n) { }
        private static int Compute(int v) { return v; }
        private static Widget Mk() { return null; }

        public void Wire(Widget button, int status)
        {
            Register(HandleThing);
            Register(this.HandleThing);
            Register(C.StaticHandler);
            button.Click += OnClick;
            this.status = status;
            Del d = Handler;
            Action g = () => Register(HandleThing);
        }

        public void CallsZoo(Widget p, MyDel myDel, HttpRequest request)
        {
            Helper();
            Generic<int>(5);
            this.Run(1);
            base.Method();
            _repo.Save(2);
            var svcs = builder
                .Services
                .AddSingleton<IRepo, Repo>();
            "lit".ToUpper();
            request?.Method();
            p!.Force();
            Foo.Create(1).Bar();
            GetThing().Bar();
            (myDel)(3);
            var n = nameof(Widget);
        }

        public void Reads(User u)
        {
            DoThing(Constants.MAX);
            var x = ReadType.ReadAsDouble;
            var y = Outer.Inner.DEEP;
            var age = u.Age;
            Console.WriteLine(x);
        }

        public void News()
        {
            var a = new Widget(1) { Name = Mk() };
            var b = new Ns.Foo<int>();
            Widget c = new();
            var d = new { X = 1 };
            var e = new Widget[10];
            var f = new[] { Mk() };
        }

        public IEnumerable<int> Query(List<int> items)
        {
            var q = from x in items where Check(x) select Map(x);
            var s = items.Count switch { 0 => One(), _ => Other() };
            var msg = $"Hello {NameOf(this)}";
            var raw = """raw text""";
            var verb = @"verbatim\path";
            int[] coll = [First(), Second()];
            return q;
        }

        public int WithLocal()
        {
            int Local(int v) { return Compute(v); }
            return Local(2);
        }

        public Task<List<Widget>> Fetch(Widget? maybe, Widget[] arr, (int Code, Widget Payload) pair, List<Widget> list, Sys.ICloneable c, dynamic dyn, String s, int nn) { return null; }
        public Task<Widget> Single() { return null; }
        public Ns.Foo Qual() { return null; }

        public int Reader()
        {
            var LOCAL_SHADOWED = 1;
            return MaxItems + LOCAL_SHADOWED;
        }

        public string Reader2() => DefaultName.Trim();
    }

    public class Client : ClientBase<Widget>, Sys.ICloneable, IThing { }

    public partial class PartialHost { partial void Hook(); }
    public partial class PartialHost { partial void Hook() { } }

    public interface IWidgetRepo<T> where T : IEntity
    {
        Task<T> Get(int id);
        string Label { get; }
        int Compute(int x) => x + 1;
    }

    public enum ReadType : byte
    {
        [Obsolete] ReadAsInt = 1,
        ReadAsDouble,
    }

    public struct Point3 { public int X; }

    #region grouped
    public class Grouped { }
    #endregion
}

namespace Torture.Beta
{
    public class Other { }
}
