import { Construction } from "lucide-react";

interface Props {
  phase: string;
  description: string;
  status: string;
}

/**
 * Shared placeholder for Setup pages that land in later Phase 8 sub-phases
 * (8B–8H). Shows an explicit "not available yet" state instead of faking
 * functionality, per Phase 8 scope rules.
 */
export default function SetupInactive({ phase, description, status }: Props) {
  return (
    <div className="setup-page" data-testid={`setup-inactive-${phase}`}>
      <div className="setup-setup-inactive-card">
        <Construction size={30} />
        <p className="setup-inactive-title">Available in Phase {phase}</p>
        <p className="setup-inactive-desc">{description}</p>
        <p className="setup-inactive-status">{status}</p>
      </div>
    </div>
  );
}