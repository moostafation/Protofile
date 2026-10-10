using System;
using Protofile.Sp3d;
using Xunit;

public class PipeRunNamingTests
{
    private const string Line = "6-CW-1024-A1A-N";

    [Fact]
    public void FirstRunIsR01()
    {
        Assert.Equal(Line + "-R01", PipeRunNaming.Build(Line, new string[0]));
    }

    [Fact]
    public void NextRunIncrements()
    {
        Assert.Equal(Line + "-R03", PipeRunNaming.Build(Line, new[] { Line + "-R01", Line + "-R02" }));
    }

    [Fact]
    public void DeletedNumberIsNotReused()
    {
        // R01 was deleted, R02 remains: next must be R03, not R01.
        Assert.Equal(Line + "-R03", PipeRunNaming.Build(Line, new[] { Line + "-R02" }));
    }

    [Fact]
    public void OtherPipelinesAreIgnored()
    {
        Assert.Equal(Line + "-R01", PipeRunNaming.Build(Line, new[] { "3-FW-2007-B2B-N-R05" }));
    }

    [Fact]
    public void NameIsUppercased()
    {
        Assert.Equal("6-CW-1024-A1A-N-R01", PipeRunNaming.Build("6-cw-1024-a1a-n", new string[0]));
    }

    [Fact]
    public void InvalidCharactersAreRejected()
    {
        Assert.Throws<InvalidOperationException>(() => PipeRunNaming.Build("6 CW_1024", new string[0]));
    }

    [Fact]
    public void EmptyPipelineIsRejected()
    {
        Assert.Throws<ArgumentException>(() => PipeRunNaming.Build("", new string[0]));
    }
}
