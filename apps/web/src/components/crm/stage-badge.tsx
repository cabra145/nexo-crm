import { LIFECYCLE_LABELS, type LifecycleStage } from '@nexo/contracts';
import { Badge } from '@/components/ui/badge';

const TONES: Record<LifecycleStage, 'neutral' | 'primary' | 'positive' | 'warning' | 'critical'> = {
  LEAD: 'neutral',
  PROSPECT: 'primary',
  CUSTOMER: 'positive',
  EVANGELIST: 'positive',
  CHURNED: 'critical',
  OTHER: 'neutral',
};

export function StageBadge({ stage }: { stage: LifecycleStage }) {
  return <Badge tone={TONES[stage]}>{LIFECYCLE_LABELS[stage]}</Badge>;
}
