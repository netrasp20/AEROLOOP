import { useMemo, useState } from "react";

import ParameterStatusBar from "./ParameterStatusBar";
import ParameterNav from "./ParameterNav";
import ParameterActions from "./ParameterActions";
import ParameterGroupTree from "./ParameterGroupTree";
import ParameterTable from "./ParameterTable";
import FlightModes from "./FlightModes";
import BasicTuning from "./BasicTuning";
import ExtendedTuning from "./ExtendedTuning";
import GeoFence from "./GeoFence";
import PlannerSettings from "./PlannerSettings";
import OsdConfig from "./OsdConfig";
import MavFtp from "./MavFtp";
import WriteParamsDialog from "./WriteParamsDialog";
import { FileDialog, SaveDialog, PresetsDialog, ResetDialog } from "./ParameterFileDialogs";

import { useParameters } from "../../context/ParameterContext";

import {
  buildGroups,
  entriesOf,
  filterByLevel,
  searchParams,
  sortById,
  toRowView,
} from "../../parameters/parametersLogic";

import type { NavItem } from "./ParameterNav";

import { modifiedIds } from "../../parameters/stagedLogic";

import "../../styles/parameters.css";
import "../../styles/mission-planner.css";

export default function ParametersScreen() {
  const store = useParameters();

  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<"all" | "standard" | "advanced">("all");
  const [navId, setNavId] = useState("all");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);

  const [writeDialogOpen, setWriteDialogOpen] = useState(false);
  const [fileMode, setFileMode] = useState<"load" | "compare" | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const all = useMemo(() => entriesOf(store.entries), [store.entries]);

  const stagedIdSet = useMemo(() => modifiedIds(store.staged), [store.staged]);

  const segmented = useMemo(
    () => filterByLevel(all, level, stagedIdSet),
    [all, level, stagedIdSet]
  );

  const groups = useMemo(() => buildGroups(segmented), [segmented]);

  const activeGroupExists =
    activeGroup !== null &&
    groups.some((group) => group.name === activeGroup);

  const tableEntries = useMemo(() => {
    let source = all;
    if (level !== "all") source = segmented;
    if (activeGroup && activeGroupExists) {
      const group = groups.find((g) => g.name === activeGroup);
      if (group) source = group.entries;
    }
    if (modifiedOnly) {
      source = source.filter((e) => stagedIdSet.has(e.id));
    }
    source = searchParams(source, query);
    return sortById(source);
  }, [all, segmented, groups, level, activeGroup, activeGroupExists, query, modifiedOnly, stagedIdSet]);

  const rows = useMemo(
    () => tableEntries.map((entry) => toRowView(entry, store.staged[entry.id] ?? null)),
    [tableEntries, store.staged]
  );

  const syncing = store.sync.active || store.refreshing;

  function handleNavSelect(item: NavItem) {
    setNavId(item.id);
    if (item.level && item.level !== "modified") {
      setLevel(item.level as "all" | "standard" | "advanced");
      if (item.level === "all") {
        setActiveGroup(null);
      }
    }
  }

  function handleGroupSelect(name: string | null) {
    setActiveGroup(name);
  }

  return (
    <div className="mp-screen" data-testid="param-screen">
      <ParameterStatusBar />

      <div className="mp-body" style={(navId === "modes" || navId === "basic" || navId === "extended" || navId === "geofence" || navId === "planner" || navId === "osd" || navId === "ftp") ? { gridTemplateColumns: "230px 1fr" } : undefined}>
        <aside className="mp-panel mp-nav-panel">
          <ParameterNav
            activeId={navId}
            level={level}
            counts={{
              all: all.length,
              standard: filterByLevel(all, "standard").length,
              advanced: filterByLevel(all, "advanced").length,
            }}
            onSelect={handleNavSelect}
          />

          <div className="mp-nav-separator" />
          <div className="mp-nav-title">Groups</div>
          <ParameterGroupTree
            groups={groups}
            activeGroup={activeGroup}
            onSelect={handleGroupSelect}
          />
        </aside>

        <section className="mp-panel mp-table-panel">
          {navId === "modes" ? (
            <FlightModes />
          ) : navId === "basic" ? (
            <BasicTuning />
          ) : navId === "extended" ? (
            <ExtendedTuning />
          ) : navId === "geofence" ? (
            <GeoFence />
          ) : navId === "planner" ? (
            <PlannerSettings />
          ) : navId === "osd" ? (
            <OsdConfig />
          ) : navId === "ftp" ? (
            <MavFtp />
          ) : (
            <ParameterTable
              rows={rows}
              entries={store.entries}
              selectedId={selectedId}
              onSelect={setSelectedId}
              connection={store.connection}
              syncing={syncing}
              loading={store.loading}
              error={store.loadError}
              query={query}
              count={store.count}
              staged={store.staged}
              onStage={store.stageValue}
              onRevert={store.revert}
            />
          )}
        </section>

        {navId !== "modes" && navId !== "basic" && navId !== "extended" && navId !== "geofence" && navId !== "planner" && navId !== "osd" && navId !== "ftp" && (
          <aside className="mp-panel mp-actions-panel">
            <ParameterActions
              query={query}
              onQueryChange={setQuery}
              modifiedOnly={modifiedOnly}
              onModifiedChange={setModifiedOnly}
              onLoadFile={() => setFileMode("load")}
              onSaveFile={() => setSaveOpen(true)}
              onWrite={() => setWriteDialogOpen(true)}
              onCompare={() => setFileMode("compare")}
              onLoadPreset={() => setPresetsOpen(true)}
              onReset={() => setResetOpen(true)}
            />
          </aside>
        )}
      </div>

      <WriteParamsDialog open={writeDialogOpen} onClose={() => setWriteDialogOpen(false)} />
      <FileDialog mode={fileMode} onClose={() => setFileMode(null)} />
      <SaveDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
      <PresetsDialog open={presetsOpen} onClose={() => setPresetsOpen(false)} />
      <ResetDialog open={resetOpen} onClose={() => setResetOpen(false)} />
    </div>
  );
}