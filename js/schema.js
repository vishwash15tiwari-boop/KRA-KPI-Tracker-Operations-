/* ============================================================================
 * SCHEMA — the relational model, expressed as IndexedDB object stores with
 * indexes. One store per table; keyPath is the primary key; `fk` documents the
 * foreign keys the data layer enforces (IndexedDB has none natively, so DB.put
 * validates them). This is the single source of truth for the database shape;
 * DB.js reads it to build the stores and to run referential-integrity checks.
 * Bump VERSION when the shape changes — onupgradeneeded migrates.
 * ========================================================================== */
window.EPM_SCHEMA = {
  name: 'epm_platform',
  version: 1,
  stores: {
    org_types:      { key: 'id', indexes: [], fk: {} },
    org_units:      { key: 'id', indexes: ['orgTypeId', 'status'], fk: { orgTypeId: 'org_types', headId: 'employees?' } },
    teams:          { key: 'id', indexes: ['orgUnitId', 'leaderId', 'status'], fk: { orgUnitId: 'org_units', leaderId: 'employees?' } },
    employees:      { key: 'id', indexes: ['teamId', 'orgUnitId', 'orgTypeId', 'managerId', 'designation', 'employmentStatus', 'roleId'],
                      fk: { orgTypeId: 'org_types', orgUnitId: 'org_units', teamId: 'teams?', managerId: 'employees?', functionalHeadId: 'employees?', roleId: 'roles' } },
    roles:          { key: 'id', indexes: [], fk: {} },
    kras:           { key: 'id', indexes: ['status'], fk: {} },
    kpis:           { key: 'id', indexes: ['kraId', 'status', 'direction'], fk: { kraId: 'kras' } },
    cycles:         { key: 'id', indexes: [], fk: {} },
    periods:        { key: 'id', indexes: ['cycleId', 'kind', 'status', 'sort'], fk: { cycleId: 'cycles' } },
    assignments:    { key: 'id', indexes: ['employeeId', 'kpiId', 'kraId', 'source', 'status'],
                      fk: { employeeId: 'employees', kpiId: 'kpis', kraId: 'kras' } },
    targets:        { key: 'id', indexes: ['employeeId', 'kpiId', 'periodId', 'status', 'empKpiPeriod'],
                      fk: { employeeId: 'employees', kpiId: 'kpis', periodId: 'periods' } },
    performance:    { key: 'id', indexes: ['employeeId', 'teamId', 'kraId', 'kpiId', 'periodId', 'status', 'highestLevel', 'empPeriod', 'empKpiPeriod'],
                      fk: { employeeId: 'employees', teamId: 'teams', kraId: 'kras', kpiId: 'kpis', periodId: 'periods' } },
    reviews:        { key: 'id', indexes: ['employeeId', 'periodId', 'status', 'empPeriod'],
                      fk: { employeeId: 'employees', periodId: 'periods' } },
    notifications:  { key: 'id', indexes: ['recipientId', 'type', 'read', 'createdAt'], fk: {} },
    audit:          { key: 'id', indexes: ['entityType', 'entityId', 'actorId', 'ts'], fk: {} },
    settings:       { key: 'key', indexes: [], fk: {} },
    meta:           { key: 'key', indexes: [], fk: {} }
  }
};
