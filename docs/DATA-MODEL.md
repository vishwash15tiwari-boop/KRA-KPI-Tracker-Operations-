# Data Model

23 tables in the backend spreadsheet. Every table declares its columns and types in
`src/server/01_Schema.gs`; the bootstrap routine creates or migrates the physical
sheets to match. Migration is forward-only — columns are appended, never dropped or
reordered.

## Conventions

* Column 1 is always the surrogate primary key.
* Mutable tables carry `createdAt` / `createdBy` / `updatedAt` / `updatedBy`.
* Facts are upserted on a natural key, so re-running a sync corrects rather than duplicates.
* Deletes are soft where the table has an `active` or `voided` flag. Operational
  history is never silently destroyed.
* `accountId` / `gstin` is the join key between plans, activities and facts. Facts
  also snapshot `regionId` and `pocUserId` so history survives a re-assignment.

## Relationships

```
DB_Users -+-< DB_KPIAssignment >- DB_KPI >- DB_KRA >- DB_Cycles
          +-< DB_Accounts >-+-< DB_AccountPlan >- DB_Cycles
          |                 +-< DB_Activities
          |                 +-< DB_Pulse
          |                 +-< DB_Receivables
          +-< DB_OnboardingPlan
          +-< DB_WeeklyPlan
          +-< DB_Reviews >-< DB_Actions
          +-< DB_Pipeline >-< DB_Documents

DB_Shipments  --gstin--> DB_Accounts        (synced fact)
DB_Onboarding --gstin--> DB_Accounts        (synced fact)
DB_Regions -< DB_Users, DB_Accounts, facts
DB_Snapshots, DB_Audit, DB_SyncLog, DB_Config  (no foreign keys)
```

## Tables

### `DB_Config`

Runtime overrides for the tunable business rules. Keys not present fall back to the shipped defaults.

Primary key `key` - 5 columns

| Column | Type | Notes |
|--------|------|-------|
| `key` | STR |  |
| `value` | STR |  |
| `description` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_Users`

Identity, role and scope. `fullName` and `aliases` are how the sync links a source-system name to a person.

Primary key `userId` - indexed on 'email', 'fullName' - 16 columns

| Column | Type | Notes |
|--------|------|-------|
| `userId` | STR |  |
| `email` | STR |  |
| `fullName` | STR |  |
| `employeeCode` | STR |  |
| `role` | STR | enum |
| `category` | STR | Plastic | Metal | ALL |
| `regionId` | STR |  |
| `stream` | STR | SUPPLY | DEMAND | BOTH |
| `reportsTo` | STR | userId of manager |
| `phone` | STR |  |
| `active` | BOOL |  |
| `aliases` | STR | pipe-separated names used in source systems |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_Regions`

Regional dimension, per category, with its Regional Head.

Primary key `regionId` - indexed on 'regionName' - 10 columns

| Column | Type | Notes |
|--------|------|-------|
| `regionId` | STR |  |
| `regionName` | STR |  |
| `category` | STR |  |
| `rhUserId` | STR | Regional Head |
| `states` | STR | comma-separated |
| `active` | BOOL |  |
| `sequence` | NUM |  |
| `createdAt` | DATETIME |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_Cycles`

One month for one category. Holds the lifecycle state that gates planning and activity capture.

Primary key `cycleId` - indexed on 'category', 'year', 'month' - 20 columns

| Column | Type | Notes |
|--------|------|-------|
| `cycleId` | STR | CYC-<Category>-<YYYY>-<MM> |
| `category` | STR |  |
| `year` | NUM |  |
| `month` | NUM | 1-12 |
| `label` | STR | Aug 2026 · Plastic |
| `status` | STR | enum |
| `workingDays` | NUM |  |
| `startDate` | DATE |  |
| `endDate` | DATE |  |
| `notes` | STR |  |
| `publishedBy` | STR |  |
| `publishedAt` | DATETIME |  |
| `lockedBy` | STR |  |
| `lockedAt` | DATETIME |  |
| `closedBy` | STR |  |
| `closedAt` | DATETIME |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_KRA`

Key Result Areas. `cycleId = LIBRARY` marks the reusable template rows.

Primary key `kraId` - indexed on 'cycleId' - 13 columns

| Column | Type | Notes |
|--------|------|-------|
| `kraId` | STR |  |
| `cycleId` | STR |  |
| `category` | STR |  |
| `stream` | STR | STREAMS |
| `perspective` | STR | Sales | Scale | Customer | Process |
| `kraName` | STR |  |
| `sourceOfTracking` | STR |  |
| `sequence` | NUM |  |
| `active` | BOOL |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_KPI`

KPIs under a KRA: weightage, the metric that measures it, how its target is derived, and the five rating bands.

Primary key `kpiId` - indexed on 'cycleId', 'kraId' - 23 columns

| Column | Type | Notes |
|--------|------|-------|
| `kpiId` | STR |  |
| `kraId` | STR |  |
| `cycleId` | STR |  |
| `kpiName` | STR |  |
| `definition` | STR |  |
| `weightage` | NUM |  |
| `unitOfMeasure` | STR | Percentage | Days | Count | MT | Cr |
| `metricKey` | STR | key into METRICS |
| `direction` | STR | enum |
| `targetBasis` | STR | enum |
| `basisMetric` | STR | metric the % applies to, for PCT_OF_METRIC |
| `basisPct` | NUM |  |
| `target1` | NUM |  |
| `target2` | NUM |  |
| `target3` | NUM |  |
| `target4` | NUM |  |
| `target5` | NUM |  |
| `sequence` | NUM |  |
| `active` | BOOL |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_KPIAssignment`

Which POC owns which KPI this cycle, with optional weightage and target overrides.

Primary key `assignmentId` - indexed on 'cycleId', 'pocUserId', 'kpiId' - 16 columns

| Column | Type | Notes |
|--------|------|-------|
| `assignmentId` | STR |  |
| `cycleId` | STR |  |
| `kpiId` | STR |  |
| `pocUserId` | STR |  |
| `regionId` | STR |  |
| `category` | STR |  |
| `weightage` | NUM | override; blank inherits the KPI weightage |
| `targetValue` | NUM | blank when derived |
| `targetOverride` | BOOL |  |
| `dueDate` | DATE |  |
| `notes` | STR |  |
| `active` | BOOL |  |
| `assignedBy` | STR |  |
| `assignedAt` | DATETIME |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_Accounts`

Sellers and buyers in one table, discriminated by `accountType` and keyed on GSTIN.

Primary key `accountId` - indexed on 'gstin', 'accountType', 'pocUserId' - 31 columns

| Column | Type | Notes |
|--------|------|-------|
| `accountId` | STR |  |
| `accountType` | STR | [`SELLER`, `BUYER`] |
| `gstin` | STR | natural key; joins to facts |
| `externalId` | STR | Seller_ID / Buyer_ID in the ops system |
| `businessName` | STR |  |
| `category` | STR |  |
| `regionId` | STR |  |
| `pocUserId` | STR |  |
| `contactPerson` | STR |  |
| `mobile` | STR |  |
| `email` | STR |  |
| `state` | STR |  |
| `city` | STR |  |
| `accountSubType` | STR | Baler | Trader | Manufacturer … |
| `materialType` | STR |  |
| `paymentTerms` | STR |  |
| `counterpartyName` | STR | linked buyer for a seller and vice versa |
| `onboardingStatus` | STR | enum |
| `onboardedDate` | DATE |  |
| `firstTxnDate` | DATE |  |
| `lastTxnDate` | DATE |  |
| `lastVisitDate` | DATE |  |
| `businessVintage` | STR |  |
| `blockerReason` | STR |  |
| `remarks` | STR |  |
| `active` | BOOL |  |
| `sourceSystem` | STR |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_AccountPlan`

The monthly per-account target — the only human input behind GMV and tonnage targets.

Primary key `planId` - indexed on 'cycleId', 'accountId', 'pocUserId' - 22 columns

| Column | Type | Notes |
|--------|------|-------|
| `planId` | STR |  |
| `cycleId` | STR |  |
| `accountId` | STR |  |
| `accountType` | STR |  |
| `gstin` | STR |  |
| `accountName` | STR |  |
| `pocUserId` | STR |  |
| `regionId` | STR |  |
| `category` | STR |  |
| `materialType` | STR |  |
| `txnTarget` | NUM |  |
| `tonnageTargetMT` | NUM |  |
| `ratePerKgTarget` | NUM |  |
| `gmvTargetCr` | NUM | derived = tonnage × rate / 10000 |
| `remarks` | STR |  |
| `detailedRemarks` | STR |  |
| `blockerReason` | STR |  |
| `active` | BOOL |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_OnboardingPlan`

The annual acquisition plan per POC. Drives the balance-carried-forward monthly target.

Primary key `onbPlanId` - indexed on 'fiscalYear', 'pocUserId' - 12 columns

| Column | Type | Notes |
|--------|------|-------|
| `onbPlanId` | STR |  |
| `fiscalYear` | STR | FY2026-27 |
| `category` | STR |  |
| `accountType` | STR |  |
| `pocUserId` | STR |  |
| `regionId` | STR |  |
| `annualPlan` | NUM |  |
| `notes` | STR |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_WeeklyPlan`

Daily tonnage targets per POC. Achievement is computed, never entered.

Primary key `weekPlanId` - indexed on 'cycleId', 'pocUserId', 'planDate' - 14 columns

| Column | Type | Notes |
|--------|------|-------|
| `weekPlanId` | STR |  |
| `cycleId` | STR |  |
| `category` | STR |  |
| `weekStart` | DATE |  |
| `planDate` | DATE |  |
| `pocUserId` | STR |  |
| `regionId` | STR |  |
| `tonnageTargetMT` | NUM |  |
| `txnTarget` | NUM |  |
| `notes` | STR |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_Activities`

The single operational record. Every dashboard number traces to a row here or to a synced fact.

Primary key `activityId` - indexed on 'cycleId', 'pocUserId', 'activityDate', 'activityType' - 36 columns

| Column | Type | Notes |
|--------|------|-------|
| `activityId` | STR |  |
| `cycleId` | STR |  |
| `category` | STR |  |
| `stream` | STR |  |
| `activityType` | STR |  |
| `activityDate` | DATE |  |
| `pocUserId` | STR |  |
| `regionId` | STR |  |
| `accountId` | STR |  |
| `accountType` | STR |  |
| `gstin` | STR |  |
| `accountName` | STR |  |
| `kraId` | STR |  |
| `kpiId` | STR |  |
| `metricKey` | STR |  |
| `count` | NUM |  |
| `quantityMT` | NUM |  |
| `ratePerKg` | NUM |  |
| `amountINR` | NUM |  |
| `status` | STR |  |
| `blockerReason` | STR |  |
| `remarks` | STR |  |
| `evidenceUrl` | STR |  |
| `evidenceType` | STR |  |
| `verificationStatus` | STR | [`PENDING`, `VERIFIED`, `REJECTED`, `NOT_REQUIRED`] |
| `verifiedBy` | STR |  |
| `verifiedAt` | DATETIME |  |
| `verifyNote` | STR |  |
| `sourceSystem` | STR | APP | SYNC:<sheet> |
| `sourceRef` | STR | natural key for idempotent sync |
| `voided` | BOOL |  |
| `voidReason` | STR |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_Shipments`

Transaction facts, mirrored from `Overall Shipments`. `txnDate` (Draft_Date) is the window basis for every period.

Primary key `shipmentKey` - indexed on 'sellerGstin', 'buyerGstin', 'txnDate', 'pocUserId' - 45 columns

| Column | Type | Notes |
|--------|------|-------|
| `shipmentKey` | STR | Shipment_ID (natural key) |
| `category` | STR |  |
| `requisitionId` | STR |  |
| `listingId` | STR |  |
| `salesOrderId` | STR |  |
| `buyerGstin` | STR |  |
| `buyerName` | STR |  |
| `sellerGstin` | STR |  |
| `sellerName` | STR |  |
| `hsnCode` | STR |  |
| `itemNames` | STR |  |
| `materialType` | STR |  |
| `requestedQtyMT` | NUM |  |
| `bookedQtyMT` | NUM |  |
| `finalRatePerKg` | NUM | source header says per MT; values are per kg |
| `invoiceDate` | DATE |  |
| `invoiceNumber` | STR |  |
| `ewayBillNumber` | STR |  |
| `invoiceQtyMT` | NUM |  |
| `invoiceTaxableAmount` | NUM |  |
| `invoiceGstAmount` | NUM |  |
| `invoiceTotalAmount` | NUM |  |
| `paymentTermsDays` | NUM |  |
| `paymentTermBucket` | STR |  |
| `shipmentStatus` | STR |  |
| `orderStatus` | STR |  |
| `txnDate` | DATE | Draft_Date — the window basis |
| `createdDate` | DATETIME |  |
| `orderVerifiedDate` | DATETIME |  |
| `dispatchedDate` | DATETIME |  |
| `reachedDate` | DATETIME |  |
| `receivedDate` | DATETIME |  |
| `completedDate` | DATETIME |  |
| `cancelledDate` | DATETIME |  |
| `rejectedDate` | DATETIME |  |
| `businessWeek` | STR |  |
| `monthWeek` | STR |  |
| `regionId` | STR | supply-side region |
| `pocUserId` | STR | supply-side (seller) POC |
| `buyerRegionId` | STR |  |
| `buyerPocUserId` | STR | demand-side (buyer) POC |
| `isValidTxn` | BOOL |  |
| `hasShipmentId` | BOOL | false when keyed off the order — no shipment raised yet |
| `syncedAt` | DATETIME |  |
| `syncBatch` | STR |  |

### `DB_Onboarding`

Onboarding facts, mirrored from `Seller Onboarding`, with the SLA measured on import.

Primary key `onboardingKey` - indexed on 'gstin', 'pocUserId', 'onboardedDate' - 47 columns

| Column | Type | Notes |
|--------|------|-------|
| `onboardingKey` | STR | Seller_ID / Buyer_ID |
| `accountType` | STR |  |
| `category` | STR |  |
| `businessVertical` | STR |  |
| `gstin` | STR |  |
| `businessName` | STR |  |
| `regionId` | STR |  |
| `rhName` | STR |  |
| `pocUserId` | STR |  |
| `accountSubType` | STR |  |
| `status` | STR |  |
| `contactPerson` | STR |  |
| `mobile` | STR |  |
| `email` | STR |  |
| `state` | STR |  |
| `city` | STR |  |
| `effectiveRegistrationDate` | DATE |  |
| `businessVintage` | STR |  |
| `createdDate` | DATETIME |  |
| `reviewSubmissionDate` | DATETIME |  |
| `onboardedDate` | DATE |  |
| `updatedDate` | DATETIME |  |
| `decisionReason` | STR |  |
| `createdByName` | STR |  |
| `submittedByName` | STR |  |
| `updatedByName` | STR |  |
| `totalListings` | NUM |  |
| `approvedListings` | NUM |  |
| `closedListings` | NUM |  |
| `expiredListings` | NUM |  |
| `rejectedListings` | NUM |  |
| `listingsConverted` | NUM |  |
| `listingsNotConverted` | NUM |  |
| `lastListingDate` | DATE |  |
| `daysInactive` | NUM |  |
| `totalOrders` | NUM |  |
| `totalShipments` | NUM |  |
| `shipDispatched` | NUM |  |
| `shipReached` | NUM |  |
| `shipReceived` | NUM |  |
| `shipCompleted` | NUM |  |
| `shipCancelled` | NUM |  |
| `cancelledBeforeShipment` | NUM |  |
| `onboardingSlaDays` | NUM | created → onboarded |
| `slaBreached` | BOOL |  |
| `syncedAt` | DATETIME |  |
| `syncBatch` | STR |  |

### `DB_Pulse`

Field-visit facts, normalised from the wide daily grid to one row per person per day.

Primary key `pulseId` - indexed on 'pocUserId', 'visitDate' - 19 columns

| Column | Type | Notes |
|--------|------|-------|
| `pulseId` | STR |  |
| `category` | STR |  |
| `visitDate` | DATE |  |
| `pocUserId` | STR |  |
| `employeeCode` | STR |  |
| `regionId` | STR |  |
| `accountId` | STR |  |
| `gstin` | STR |  |
| `accountName` | STR |  |
| `visitCount` | NUM |  |
| `onLeave` | BOOL |  |
| `purpose` | STR |  |
| `outcome` | STR |  |
| `remarks` | STR |  |
| `evidenceUrl` | STR |  |
| `sourceSystem` | STR |  |
| `sourceRef` | STR |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |

### `DB_Receivables`

Feeds DSO Days and DN % of GMV — the two lower-is-better Demand KPIs.

Primary key `receivableId` - indexed on 'cycleId', 'buyerGstin' - 18 columns

| Column | Type | Notes |
|--------|------|-------|
| `receivableId` | STR |  |
| `cycleId` | STR |  |
| `category` | STR |  |
| `buyerGstin` | STR |  |
| `buyerName` | STR |  |
| `pocUserId` | STR |  |
| `regionId` | STR |  |
| `asOnDate` | DATE |  |
| `openingReceivableINR` | NUM |  |
| `closingReceivableINR` | NUM |  |
| `debitNoteINR` | NUM | DN |
| `creditNoteINR` | NUM |  |
| `overdueINR` | NUM |  |
| `remarks` | STR |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_Pipeline`

Prospect and onboarding pipeline. A row cannot reach ONBOARDED until its document checklist is complete.

Primary key `pipelineId` - indexed on 'category', 'pocUserId', 'stage' - 28 columns

| Column | Type | Notes |
|--------|------|-------|
| `pipelineId` | STR |  |
| `accountType` | STR |  |
| `category` | STR |  |
| `businessName` | STR |  |
| `gstin` | STR |  |
| `commodity` | STR |  |
| `regionId` | STR |  |
| `state` | STR |  |
| `city` | STR |  |
| `mobile` | STR |  |
| `contactPerson` | STR |  |
| `pocUserId` | STR |  |
| `paymentTerms` | STR |  |
| `stage` | STR | enum |
| `documentStatus` | STR | derived from DB_Documents |
| `expectedTonnageMT` | NUM |  |
| `expectedOnboardDate` | DATE |  |
| `onboardedDate` | DATE |  |
| `currentOrders` | NUM |  |
| `blockerReason` | STR |  |
| `remarks` | STR |  |
| `lastActionDate` | DATE |  |
| `nextActionDate` | DATE |  |
| `active` | BOOL |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_Documents`

Real document slots replacing the emoji checklist, each with an evidence link.

Primary key `documentId` - indexed on 'pipelineId', 'slotKey' - 14 columns

| Column | Type | Notes |
|--------|------|-------|
| `documentId` | STR |  |
| `pipelineId` | STR |  |
| `accountId` | STR |  |
| `slotKey` | STR |  |
| `slotLabel` | STR |  |
| `collected` | BOOL |  |
| `evidenceUrl` | STR |  |
| `collectedDate` | DATE |  |
| `expiryDate` | DATE |  |
| `verifiedBy` | STR |  |
| `verifiedAt` | DATETIME |  |
| `remarks` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_Reviews`

A review freezes the scorecard as `snapshot`, so a later fact correction cannot rewrite history.

Primary key `reviewId` - indexed on 'cycleId', 'subjectUserId' - 24 columns

| Column | Type | Notes |
|--------|------|-------|
| `reviewId` | STR |  |
| `cycleId` | STR |  |
| `category` | STR |  |
| `reviewLevel` | STR | [`POC`, `REGION`, `TEAM`] |
| `subjectUserId` | STR |  |
| `subjectRegionId` | STR |  |
| `reviewDate` | DATE |  |
| `weightedScore` | NUM |  |
| `overallAchievement` | NUM |  |
| `rating` | NUM |  |
| `ratingLabel` | STR |  |
| `strengths` | STR |  |
| `gaps` | STR |  |
| `leadershipNote` | STR |  |
| `pocResponse` | STR |  |
| `status` | STR | [`DRAFT`, `SHARED`, `ACKNOWLEDGED`, `SIGNED_OFF`] |
| `snapshot` | JSON | frozen scorecard at review time |
| `reviewedBy` | STR |  |
| `reviewedAt` | DATETIME |  |
| `acknowledgedAt` | DATETIME |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_Actions`

Owned, dated follow-ups. They reappear on the owner's My Day screen until closed.

Primary key `actionId` - indexed on 'cycleId', 'ownerUserId', 'status' - 22 columns

| Column | Type | Notes |
|--------|------|-------|
| `actionId` | STR |  |
| `cycleId` | STR |  |
| `category` | STR |  |
| `reviewId` | STR |  |
| `sourceType` | STR | REVIEW | ALERT | MANUAL |
| `sourceRef` | STR |  |
| `title` | STR |  |
| `description` | STR |  |
| `ownerUserId` | STR |  |
| `regionId` | STR |  |
| `accountId` | STR |  |
| `kpiId` | STR |  |
| `priority` | STR | [`P1`, `P2`, `P3`] |
| `dueDate` | DATE |  |
| `status` | STR | [`OPEN`, `IN_PROGRESS`, `BLOCKED`, `DONE`, `CANCELLED`] |
| `closureRemarks` | STR |  |
| `evidenceUrl` | STR |  |
| `closedAt` | DATETIME |  |
| `createdAt` | DATETIME |  |
| `createdBy` | STR |  |
| `updatedAt` | DATETIME |  |
| `updatedBy` | STR |  |

### `DB_Snapshots`

Daily frozen metric values, so trends survive later corrections to the facts.

Primary key `snapshotId` - indexed on 'snapshotDate', 'cycleId', 'scope', 'scopeKey' - 12 columns

| Column | Type | Notes |
|--------|------|-------|
| `snapshotId` | STR |  |
| `snapshotDate` | DATE |  |
| `cycleId` | STR |  |
| `category` | STR |  |
| `scope` | STR | [`OVERALL`, `REGION`, `POC`, `ACCOUNT`] |
| `scopeKey` | STR |  |
| `metricKey` | STR |  |
| `targetValue` | NUM |  |
| `actualValue` | NUM |  |
| `lmtdValue` | NUM |  |
| `achievementPct` | NUM |  |
| `createdAt` | DATETIME |  |

### `DB_Audit`

Every mutation: who, when, what, before and after — successes and failures alike.

Primary key `auditId` - indexed on 'timestamp', 'userEmail', 'entity' - 13 columns

| Column | Type | Notes |
|--------|------|-------|
| `auditId` | STR |  |
| `timestamp` | DATETIME |  |
| `userEmail` | STR |  |
| `userId` | STR |  |
| `role` | STR |  |
| `action` | STR |  |
| `entity` | STR |  |
| `entityId` | STR |  |
| `summary` | STR |  |
| `before` | JSON |  |
| `after` | JSON |  |
| `success` | BOOL |  |
| `errorMessage` | STR |  |

### `DB_SyncLog`

Every sync run with counts, warnings and the error if it failed.

Primary key `syncId` - indexed on 'startedAt', 'source' - 14 columns

| Column | Type | Notes |
|--------|------|-------|
| `syncId` | STR |  |
| `source` | STR |  |
| `sourceSpreadsheetId` | STR |  |
| `sourceSheetName` | STR |  |
| `startedAt` | DATETIME |  |
| `finishedAt` | DATETIME |  |
| `rowsRead` | NUM |  |
| `rowsInserted` | NUM |  |
| `rowsUpdated` | NUM |  |
| `rowsSkipped` | NUM |  |
| `warnings` | STR |  |
| `status` | STR |  |
| `errorMessage` | STR |  |
| `triggeredBy` | STR |  |

