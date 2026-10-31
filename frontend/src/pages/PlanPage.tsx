import PlanLayout from "./PlanLayout";

function PlanPage({
  onUploadSuccess,
}: {
  onUploadSuccess?: () => void;
}) {
  return <PlanLayout onUploadSuccess={onUploadSuccess} />;
}

export default PlanPage;