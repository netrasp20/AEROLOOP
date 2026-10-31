# Official ArduPilot parameter metadata (machine-readable)

These files are the **official** ArduPilot machine-readable parameter
definitions, generated with ArduPilot's own toolchain — not scraped from
third-party sites and not hand-typed.

- `copter.xml` — ArduCopter (used by the QUADROTOR SITL this project tests against)
- `rover.xml`  — ArduPilot Rover / APMrover2 (the project's primary target)

## How they were produced

    cd /path/to/ardupilot
    python3 Tools/autotest/param_metadata/param_parse.py --vehicle ArduCopter --format xml
    python3 Tools/autotest/param_metadata/param_parse.py --vehicle Rover     --format xml

Each emits `apm.pdef.xml`; the two files above are copies renamed by vehicle.

## Interpretation rules

- Metadata is a **static, descriptive layer**. The flight controller's live
  `PARAM_VALUE` stream remains the authority on which parameters actually
  exist and their values.
- Parameter `name` entries may carry a vehicle prefix (`ArduCopter:FOR_...`) —
  the prefix is stripped when indexing by `param_id`.
- The top-level `<parameters name="...">` containers are the parameter **group
  / category** (the Mission Planner parameter-tree grouping).
- `user="Standard|Advanced"`, `Range`, `Increment`, `Units`, `<values>`
  (enums), `<bitmask>`, `ReadOnly`, `RebootRequired` are preserved.
- A single firmware can report far fewer parameters than the catalog defines
  (undocumented/optional/compiled-out params), and may report params with no
  definition — both cases are handled by the merge layer, never by fabricating
  values.