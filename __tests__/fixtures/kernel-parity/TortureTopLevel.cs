using System;

var builder = CreateBuilder(args);
Run(builder);
var w = new Widget();
DoWork(w);
int Helper(int x) => Compute(x);
Helper(3);

partial class Program
{
    static void Main2() { Console.WriteLine("hi"); }
}
