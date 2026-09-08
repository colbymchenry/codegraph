using Coll = System.Collections.Generic.Dictionary<string, int>;
using Short = SomeType;
using System;

namespace Torture.Scoped;

/// <summary>A positional record with base args.</summary>
public record UserDto(string Name, int Age) : BaseDto(Name), IThing;

public readonly record struct Money(decimal Amount);

public record struct Pointish(int X, int Y);

public record Empty;

public record Bodied(string Label) : BaseDto(Label)
{
    public string Loud() { return Shout(Label); }
}

public class Svc(IRepo repo, ICache cache) : Base(repo), IThing
{
    public void Go() { repo.Save(1); }
}
