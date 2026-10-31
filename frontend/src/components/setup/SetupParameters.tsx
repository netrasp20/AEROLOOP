import { useMemo, useState } from "react";
import { Loader, Save, Trash2 } from "lucide-react";

import ParameterGroupTree from "../parameters/ParameterGroupTree";
import ParameterTable from "../parameters/ParameterTable";
import WriteParamsDialog from "../parameters/WriteParamsDialog";
import { useParameters } from "../../context/ParameterContext";

import {
  entriesOf,
  filterByLevel,
  searchParams,
  sortById,
  buildGroups,
  toRowView,
} from "../../parameters/parametersLogic";
import { modifiedIds } from "../../parameters/stagedLogic";

/**
 * Setup → Parameters. Reuses the existing verified parameter table, group tree,
 * staging and write-verification pipeline (Phase 1–6) without duplicating any
 * parameter logic or MAVLink communication.
 */
export default function SetupParameters() {
  const store = useParameters();

  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<"all" | "standard">("all");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [writeOpen, setWriteOpen] = useState(false);

  const all = useMemo(() => entriesOf(store.entries), [store.entries]);
  const stagedIdSet = useMemo(() => modifiedIds(store.staged), [store.staged]);
  const segmented = useMemo(
    () => filterByLevel(all, level, stagedIdSet),
    [all, level, stagedIdSet]
  );
  const groups = useMemo(() => buildGroups(segmented), [segmented]);

  const activeGroupExists =
    activeGroup !== null && groups.some((g) => g.name === activeGroup);

  const tableEntries = useMemo(() => {
    let source = level === "all" ? all : segmented;
    if (activeGroup && activeGroupExists) {
      const group = groups.find((g) => g.name === activeGroup);
      if (group) source = group.entries;
    }
    if (modifiedOnly) source = source.filter((e) => stagedIdSet.has(e.id));
    return sortById(searchParams(source, query));
  }, [all, segmented, groups, level, activeGroup, activeGroupExists, modifiedOnly, query, stagedIdSet]);

  const rows = useMemo(
    () => tableEntries.map((entry) => toRowView(entry, store.staged[entry.id] ?? null)),
    [tableEntries, store.staged]
  );

  const syncing = store.sync.active || store.refreshing;
  const stagedCount = Object.keys(store.staged).length;

  return (
    <div className="setup-page" data-testid="setup-parameters">
      <div className="setup-page-header">
        <h2 className="setup-page-title">Parameters</h2>
        <p className="setup-page-subtitle">
          Full ArduCopter parameter set with live metadata, staging and verified
          writes (shared with CONFIG).
        </p>
      </div>

      <section className="setup-card setup-params-card" data-testid="setup-params-toolbar">
        <div className="setup-params-toolbar">
          <div className="setup-params-search">
            <input
              type="text"
              className="setup-params-input"
              placeholder="Search parameters…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="setup-params-search"
            />
          </div>
          <div className="setup-params-toggles">
            <button
              type="button"
              className={`setup-params-toggle ${level === "all" ? "active" : ""}`}
              onClick={() => setLevel("all")}
              data-testid="setup-params-level-all"
            >
              All ({all.length})
            </button>
            <button
              type="button"
              className={`setup-params-toggle ${level === "standard" ? "active" : ""}`}
              onClick={() => setLevel("standard")}
              data-testid="setup-params-level-standard"
            >
              Standard
            </button>
            <button
              type="button"
              className={`setup-params-toggle ${modifiedOnly ? "active" : ""}`}
              onClick={() => setModifiedOnly(!modifiedOnly)}
              data-testid="setup-params-modified"
            >
              Modified
            </button>
          </div>
          <div className="setup-params-actions">
            <button
              type="button"
              className="setup-params-btn setup-params-btn-danger"
              onClick={store.discardAll}
              disabled={stagedCount === 0 || store.writePhase === "running"}
              data-testid="setup-params-discard"
            >
              <Trash2 size={13} />
              Discard
            </button>
            <button
              type="button"
              className="setup-params-btn setup-params-btn-primary"
              onClick={() => setWriteOpen(true)}
              disabled={stagedCount === 0 || store.writePhase === "running"}
              data-testid="setup-params-save"
            >
              {store.writePhase === "running" ? (
                <Loader size={13} className="setup-spinner" />
              ) : (
                <Save size={13} />
              )}
              Save Changes{stagedCount > 0 ? ` (${stagedCount})` : ""}
            </button>
          </div>
        </div>

        <div className="setup-params-body">
          <div className="setup-params-tree">
            <ParameterGroupTree
              groups={groups}
              activeGroup={activeGroup}
              onSelect={setActiveGroup}
            />
          </div>
          <div className="setup-params-table">
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
          </div>
        </div>
      </section>

      <WriteParamsDialog open={writeOpen} onClose={() => setWriteOpen(false)} />
    </div>
  );
}