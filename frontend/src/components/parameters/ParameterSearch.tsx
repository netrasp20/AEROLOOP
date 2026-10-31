import { Search } from "lucide-react";

interface Props {
  value: string;
  onChange: (query: string) => void;
}

export default function ParameterSearch({ value, onChange }: Props) {
  return (
    <div className="param-search-wrap">
      <Search size={15} className="param-search-icon" />
      <input
        className="param-search-input"
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search name, id, description…"
        aria-label="Search parameters"
        data-testid="param-search"
      />
      {value && (
        <button
          className="param-search-clear"
          onClick={() => onChange("")}
          aria-label="Clear search"
          title="Clear search"
        >
          ×
        </button>
      )}
    </div>
  );
}