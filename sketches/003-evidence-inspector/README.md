## Variant: Evidence Inspector

### Design stance
A split-pane technical workspace where the object, its durable evidence, and its next gate can be inspected together.

### Key choices
- Layout: project tree + preview/evidence tabs + next-safe-action inspector.
- Hierarchy: revision identity and evidence binding are always visible; technical users can inspect details quickly.
- Interaction: approval changes the gate to export-ready and opens a confirmation drawer.
- Visual posture: compact dark console with a sparse blue/green status system.

### Trade-offs
- Strong at: auditability, investigations, power-user review, future SVG/editor work.
- Weak at: most dense option; not ideal as the default beginner surface.

### Best for
An advanced evidence/audit view reachable from the guided default path.
