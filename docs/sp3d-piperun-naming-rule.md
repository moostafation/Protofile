# SP3D Pipe Run Naming Rule

Applies to Pipe Run objects in Intergraph SmartPlant 3D (Smart 3D).
This is a proposed default. Replace the fluid codes, spec classes and unit
codes with your project or client standard.

## Hierarchy

```
Pipeline (system)  ->  Pipe Run  ->  Parts (pipe, fittings, valves)
```

A pipe run is named after the pipeline it belongs to, plus a run sequence.
Every run in a pipeline can then be traced to its line number from the name alone.

## Pattern

```
<PipelineName>-R<NN>
```

| Token | Meaning | Example |
|---|---|---|
| `PipelineName` | Full line number of the parent pipeline (see below) | `6-CW-1024-A1A-N` |
| `R` | Fixed prefix marking a pipe run | `R` |
| `NN` | Two-digit run sequence within the pipeline, starting at `01` | `01`, `02` |

### Pipeline name (parent)

```
<Size>-<FluidCode>-<LineNo>-<SpecClass>-<Insulation>
```

| Token | Example | Notes |
|---|---|---|
| Size | `6` | Nominal size in inches. Use DN (`150`) if the project is metric. |
| FluidCode | `CW` | 2-3 letters. For example CW cooling water, FW fire water, CHW chilled water. |
| LineNo | `1024` | 4 digits, unique per fluid within the unit. |
| SpecClass | `A1A` | Must match the SP3D piping specification name. |
| Insulation | `N` | `N` none, `H` hot, `C` cold, `P` personnel protection. |

## Examples

| Pipe run name | Meaning |
|---|---|
| `6-CW-1024-A1A-N-R01` | First run of the 6" cooling water line 1024 |
| `6-CW-1024-A1A-N-R02` | Second run, after a branch or spec break |
| `3-FW-2007-B2B-N-R01` | First run of the 3" fire water line 2007 |

## Rules

1. Names are uppercase. Use only letters, digits and hyphens. No spaces or underscores.
2. A pipe run name always starts with its parent pipeline name. Never rename a run without renaming its pipeline.
3. Start a new run (increment `NN`) when any of these change: nominal size, piping spec, or branch. Also start a new run when the route splits at a tee.
4. Never reuse a sequence number inside a pipeline, even after a run is deleted.
5. Sizes are written without inch marks or units, so names stay valid in SP3D, isometric files and spreadsheets.
6. The name length must stay under the project's SP3D name limit (usually 50 characters).

## Implementing in SP3D

The rule is written in code, built into a DLL, then added to the project.

1. The naming logic is in `PipeRunNameRule/PipeRunNameRule.cs`. It is a draft and has not been compiled or tested.
   - `PipeRunNaming.Build` has no SP3D dependency, so it can be unit tested alone.
   - The SP3D adapter is only a TODO. It has to be written against your SP3D version's naming rule API.
2. Open `Protofile.sln` in Visual Studio, run the tests, then build the DLL.
3. Register the rule in the Catalog (bulkload, Naming Rules sheet) and assign it to the `PipeRun` class.
4. Test with two pipelines and several runs each before using it on a live model.

## Open items to confirm

- Fluid code list and spec class list for the project.
- Metric or imperial sizes.
- Whether the client requires a unit or area prefix on line numbers.
