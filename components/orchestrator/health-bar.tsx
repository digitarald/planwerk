"use client";

interface HealthBarProps {
  active: number;
  idle: number;
  errors: number;
  needsInput: number;
}

export function HealthBar({ active, idle, errors, needsInput }: HealthBarProps) {
  return (
    <div className="px-3 py-2 bg-muted/30 rounded-md mx-2 my-1">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Board Health
      </div>
      <div className="flex items-center gap-3 text-xs">
        <span className="text-emerald-600">{active} active</span>
        <span className="text-muted-foreground">{idle} idle</span>
        {errors > 0 && <span className="text-red-600">{errors} errors</span>}
        {needsInput > 0 && (
          <span className="text-amber-600">{needsInput} needs input</span>
        )}
      </div>
    </div>
  );
}
