//! Syntax-only oracle for Zig 0.16.0. Never executes indexed source or build.zig.
const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    for (args[1..], 0..) |file, index| {
        const source = try std.Io.Dir.cwd().readFileAllocOptions(
            init.io,
            file,
            init.gpa,
            .limited(16 * 1024 * 1024),
            .of(u8),
            0,
        );
        defer init.gpa.free(source);
        var tree = try std.zig.Ast.parse(init.gpa, source, .zig);
        defer tree.deinit(init.gpa);
        var buffer: [80]u8 = undefined;
        const result = try std.fmt.bufPrint(&buffer, "{d}:{d}\n", .{ index, tree.errors.len });
        try std.Io.File.stdout().writeStreamingAll(init.io, result);
    }
}
