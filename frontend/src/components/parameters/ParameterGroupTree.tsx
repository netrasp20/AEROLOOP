import type { ParamGroup } from "../../parameters/parametersLogic";

interface Props {
  groups: ParamGroup[];
  activeGroup: string | null;
  onSelect: (group: string | null) => void;
}

export default function ParameterGroupTree({
  groups,
  activeGroup,
  onSelect,
}: Props) {
  return (
    <div className="param-tree" data-testid="param-group-tree">
      <button
        className={`param-tree-item all ${activeGroup === null ? "active" : ""}`}
        onClick={() => onSelect(null)}
        data-testid="param-group-all"
      >
        <span className="param-tree-name">All Parameters</span>
        <span className="param-tree-count">
          {groups.reduce((sum, group) => sum + group.entries.length, 0)}
        </span>
      </button>

      {groups.length === 0 && (
        <div className="param-tree-empty">No groups</div>
      )}

      {groups.map((group) => (
        <button
          key={group.name}
          className={`param-tree-item ${
            activeGroup === group.name ? "active" : ""
          }`}
          onClick={() => onSelect(group.name)}
          title={group.name}
        >
          <span className="param-tree-name">{group.name}</span>
          <span className="param-tree-count">{group.entries.length}</span>
        </button>
      ))}
    </div>
  );
}