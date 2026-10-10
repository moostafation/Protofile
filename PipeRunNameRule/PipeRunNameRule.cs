// SP3D Pipe Run naming rule - DRAFT, NOT COMPILED OR TESTED.
//
// Name format:  <PipelineName>-R<NN>     e.g. 6-CW-1024-A1A-N-R01
// See docs/sp3d-piperun-naming-rule.md for the rule itself.
//
// Part 1 (PipeRunNaming) is plain C# with no SP3D dependency, so it can be
// unit tested on its own. Part 2 (the SP3D adapter) must be written against
// the Naming Rule API of your SP3D version: copy the class/method signatures
// from an existing delivered naming rule or the Programmer's Guide, because
// they differ between versions and were not checked here.

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Protofile.Sp3d
{
    public static class PipeRunNaming
    {
        public const int MaxNameLength = 50; // confirm the project's limit

        private static readonly Regex AllowedChars = new Regex("^[A-Z0-9-]+$");

        /// <summary>
        /// Builds the run name from the parent pipeline name and the names of
        /// the runs that already exist under that pipeline.
        /// </summary>
        public static string Build(string pipelineName, IEnumerable<string> existingRunNames)
        {
            if (string.IsNullOrWhiteSpace(pipelineName))
                throw new ArgumentException("Pipeline name is required.", "pipelineName");

            string pipeline = pipelineName.Trim().ToUpperInvariant();
            string prefix = pipeline + "-R";

            // Highest number ever used. Rule 4: never reuse a number.
            int max = 0;
            foreach (string existing in existingRunNames ?? new string[0])
            {
                if (existing == null || !existing.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    continue;
                int n;
                if (int.TryParse(existing.Substring(prefix.Length), out n) && n > max)
                    max = n;
            }

            int next = max + 1;
            if (next > 99)
                throw new InvalidOperationException("More than 99 runs in pipeline " + pipeline);

            string name = prefix + next.ToString("00");

            if (!AllowedChars.IsMatch(name))
                throw new InvalidOperationException("Name has invalid characters: " + name);
            if (name.Length > MaxNameLength)
                throw new InvalidOperationException("Name is longer than " + MaxNameLength + ": " + name);

            return name;
        }
    }

    // ---- Part 2: SP3D adapter -------------------------------------------------
    //
    // TODO: derive from your version's naming rule base class and, in its
    // name-computing method:
    //   1. get the parent Pipeline object and read its Name,
    //   2. collect the names of the Pipe Runs already under it,
    //   3. return PipeRunNaming.Build(pipelineName, existingRunNames).
    // Then build the DLL and register the rule through the Catalog bulkload
    // (Naming Rules sheet), and assign it to the PipeRun class.
}
