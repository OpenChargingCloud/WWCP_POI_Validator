# WWCP POI Validator

[![CI](https://github.com/OpenChargingCloud/WWCP_POI_Validator/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenChargingCloud/WWCP_POI_Validator/actions/workflows/ci.yml)
[![Nightly](https://github.com/OpenChargingCloud/WWCP_POI_Validator/actions/workflows/nightly.yml/badge.svg)](https://github.com/OpenChargingCloud/WWCP_POI_Validator/actions/workflows/nightly.yml)

A static single-page validator and explorer for [WWCP POI 3](https://github.com/OpenChargingCloud/WWCP_POI), in the
spirit of the [Metrological CBOR Validator](https://github.com/Vanaheimr/MetrologicalCBORValidator): give it the trust
anchor of a roaming network, or drop its documents, and it shows — verified by
[WWCP_POI.TS](https://github.com/OpenChargingCloud/WWCP_POI.TS) — which commits there are, who signed them, which
checkpoints the witnesses saw, and what the charging infrastructure is in every version. Everything runs locally in the
browser; nothing is uploaded anywhere.

It is meant as much for understanding WWCP POI as for checking it: every check names the section of the
[specification](https://github.com/OpenChargingCloud/WWCP_POI/blob/master/SPECIFICATION.md) it comes from, and a short
primer on the page explains how trust anchors, key statements, change sets, commits, effective trees, proofs, checkpoints,
epochs and price statements fit together.


## What it shows

- **Overview** — the verdict, the roaming network as its verified head names it, the trust anchor with its QR code, the
  head with its ETags, what the network holds, a timeline of the history and every finding.
- **Trust** — your trust decisions: which identity keys of the trust anchor you trust (below); trust transitions to
  other identity keys or the next epoch, signed by the holders of both (below); the chain from the identity keys the
  trust anchor pins to the key statement of the roaming network operator, its holders and the certificates of their
  signing keys; who signed how many commits, checkpoints and attestations; how the keys moved on (key succession,
  epochs); the keys of every party; the trusted witnesses.
- **History** — every epoch, where it starts (genesis, a checkpoint, an archive segment, or the genesis derived from the
  final checkpoint before) and how that start is anchored in the trust anchor (10.5), and each commit and checkpoint
  with what was checked: the identification, the parent, the change set applied again with the signatures of its owners
  (and who owns each change, section 4.1), the ETags it leads to, the quorum of the operator; for checkpoints their
  commits tree, the signatures of the operator and the witnesses, and the price statements they name. Refused documents
  are shown where they would have been, with the reason.
- **Network** — any version, effective (as proofs and apps see it) or as stored; a map of the charging pools; for each
  entity where its values come from (its own or a template, 9.2), the tariffs an EVSE takes and whether it is paid
  with EV Taler, the EV Taler merchant of an operator, the groups it is a member of, its runtime status, the commits
  that changed it, and its path through the effective tree up to the root the commit names — the audit paths a proof of
  it would give.
- **Proofs & prices** — station proofs as an app checks them, with how they are pruned, their key statement against the
  keys you trust (signatures, signers, quorum and validity apart), the models, hardware revisions, firmware versions and
  serial numbers of the station and its meters, the certificates they name and the transparency software proven by
  them, the keys of the operator that may sign charging documents (`chargeTransparencyRecords`); how its EVSEs are paid
  with EV Taler (the merchant the proof gives, the EV Taler tariff of each EVSE and the exchanges in its currency,
  [concepts/EVTaler.md](https://github.com/OpenChargingCloud/WWCP_POI/blob/master/concepts/EVTaler.md));
  price statements; the evidence of a charging session; proofs of commits and price statements
  in checkpoints; attestations; the archive; the **QI-Digital** papers of meters (example A14): digital calibration
  certificates, certificates of conformity and declarations of conformity, each checked against the network and against
  each other; and what an app keeps of the versions it observed (`compareObservedVersions`): each proof, its price
  statements and each trust transition in their order, whether its journal takes it, or refuses it as a rollback, a
  fork or an epoch no transition opens, and where each chain stands.
- **Sessions** — charging sessions as Chargy writes them (`.chargy`), with the evidence of WWCP POI for them, as an app
  checks them (WWCP_POI.TS 0.2.0): the meter of the EVSE and the key it signs with as the network states them now
  (`verifyMeterKey`), and as it stated them when the meter measured, with the checkpoints naming those versions
  (`verifyHistoricalMeterEvidence`); the prices bound to the session at its start, and the receipts of witnesses that
  they were public before it (`verifySessionPriceEvidence`). What is not proven is said as such: the independent time of
  a measurement, the latest version, the consent of the customer, the latest or only offer. The measurements themselves,
  signed by the meter, are Chargy's to check.
- **Documents** — everything loaded, as POI reads it. A document can be **edited and verified again**: change a price, a
  power, an identification or a signature, and see which check refuses it.


## Three ways in

1. **A trust anchor** — the text of its QR code (`WWCP/TA-2:…`), its URL (`https://…/RNs/{id}?keys=…&minConsensus=2`) or
   its JSON. *Load from its servers* asks the servers it names for what POI_API serves — the epochs and their
   checkpoints, the archive, the snapshot of the first checkpoint, the head, the commits since, the attestations, the
   price statements, and the proofs of the stations you name — and checks all of it from the pinned keys alone.
2. **Documents** dropped onto the page: snapshots, commits, checkpoints, archive segments, station proofs, price
   statements, attestations, evidence, charging sessions, QI-Digital documents, a list of trusted witnesses, a policy of
   the witnesses of price publications. What a document is follows from its JSON-LD context, or from its shape. A trust
   anchor, a list of witnesses or a policy among them goes into the settings.
3. **Demos**:
   - **QA**, the roaming network of the WWCP_POI examples A1 to A14, one recorded run (public data only), the one
     WWCP_POI.TS vendors (`tests/vectors/csharp-33447ac` today): a quorum of three holders, one operator with 16 EVSEs,
     manufacturers and their models, transparency software and its certificates, a calibration laboratory, two epochs
     (ECDSA/SHA-256, then ML-DSA/SHA-512), witnesses, price statements, evidence, and the QI-Digital papers of a meter.
   - **Thuringia**, a generated test network of medium size: seven charging station operators, 195 charging pools,
     417 stations and 834 EVSEs on a map; change sets of several owners, a key rotation, a removed pool, a latecomer
     that takes **EV Taler** at its charging parks along the A4 (its merchant, changed with a key for payments, and two
     exchanges, of which the one in euros pays); four witnessed checkpoints, price statements and station proofs.
     Signed with test keys of fixed seeds.
   - **An app: charging sessions and trust transitions**, of the test network `CHARGY-POI-DEMO` WWCP_POI.TS keeps among
     its test vectors (public test keys only). 18 sessions: the meter and its key from the proof of the station, now and
     when it measured; prices bound to the session in Ed25519, ML-DSA-65 and decimals as signed; and the receipts of the
     publication of the prices, witnessed by two organizations before the start, or not proven or refused for one reason
     each. And how its trust moves on: a proof under its trust anchor, a transition to other identity keys and one to
     epoch 2 — two ways on from the same policy —, a proof under each, and a transition refused.

   The demos are checked *as of the time of their recording*, as their attestations were valid for 15 minutes back then;
   switch the verification time to *now* in the settings to see them refused.

`index.html?demo=qa`, `index.html?demo=thuringia` and `index.html?demo=sessions` start a demo right away.


## Your trust decisions

An app that imports a trust anchor does not trust its keys by that: its user decides which of them it trusts. So do the
settings: *Identity keys of the trust anchor you trust*, all of them at first. Station proofs and charging sessions are
checked with a trust context of the keys trusted there (WWCP_POI.TS 0.1.1, `TrustContext`), which holds only where they
signed the key statement as a quorum; untrust a key to see what still holds. The history is followed from every key of
the trust anchor, as a verifier follows it. A trust context does not follow the keys of the operator to their
successors: the proofs of a later epoch, as those of the QA demo, signed by other identity keys, need the trust anchor
of those.

The trust anchor a charging session brings is trusted by nobody by itself: a session of another network is not checked
until its trust anchor is taken into the settings. Nor are the receipts of the publication of prices it brings: they
count where the *policy of the witnesses of price publications* in the settings authorizes their organizations, keys
and clocks (`witnessPublicationPolicy/v1`), once per organization.

A **trust transition** (WWCP_POI.TS 0.2.0, experimental, `trustTransition/v1`) is how trust may move on explicitly: a
compact certificate by which a quorum of the holders of a trust anchor and one of the holders of the next policy name
the policy they continue, its key statement, the trust anchor and operator that follow, and for a new epoch the
checkpoints closing the one before. The page verifies each from the trust anchor of the settings and the keys trusted
there, a later one from the one it continues, and checks the proofs of its target with it: a proof no key of the trust
anchor signed, and the proof of the start of an epoch a transition opens. It replays no history.


## Building

The validator takes WWCP_POI.TS from npm
([`@open-charging-cloud/wwcp-poi`](https://www.npmjs.com/package/@open-charging-cloud/wwcp-poi)), the release
`package-lock.json` holds:

```bash
npm --prefix "D:\Coding\OpenChargingCloud\WWCP_POI_Validator" ci
```

```bash
npm --prefix "D:\Coding\OpenChargingCloud\WWCP_POI_Validator" run build
```

Webpack writes the page to `dist/`:

```
dist/index.html
dist/styles.css
dist/leaflet.css
dist/validator.js
dist/demo/qa/…
dist/demo/thuringia/…
```

Deploying is copying `dist/` onto any web server. The demos are fetched from `demo/`, so the page has to be served over
HTTP, not opened as a file; for example:

```bash
npx --yes http-server "D:\Coding\OpenChargingCloud\WWCP_POI_Validator\dist" -p 8138 -c-1
```

The map loads its tiles from OpenStreetMap; nothing else leaves the browser.

To try the validator with a WWCP_POI.TS not yet released, build a checkout of it and take that one instead, without
changing `package.json`; `npm ci` returns to the release:

```bash
npm --prefix "D:\Coding\OpenChargingCloud\WWCP_POI.TS" run build
```

```bash
npm --prefix "D:\Coding\OpenChargingCloud\WWCP_POI_Validator" install --no-save "D:\Coding\OpenChargingCloud\WWCP_POI.TS"
```


## Loading from servers: CORS

A page may read the answers of a server of another origin only when the server allows it
(`Access-Control-Allow-Origin`). POI_API of WWCP_POI lets every origin read what it serves to everyone (CORS `*`): the
entities, and every read of a history — its head, snapshots, commits, checkpoints, epochs, the archive, proofs, price
statements, attestations — an error as well; what changes something it allows no other origin. A server in front of
it, or another implementation, may not: then *Load from its servers* works with a server that adds the header (e.g. a
reverse proxy), or with the validator served from the same origin as POI_API.

A server may limit the heavy reads of a client — snapshots, pages of commits, archive segments — and answer one beyond
with 429 Too Many Requests and `Retry-After` (specification 5.5; POI3 takes 600 per minute). The validator then waits as
long as told, a minute at most at a time, and asks again, up to six times. Another origin reads `Retry-After` only where
the server exposes it (`Access-Control-Expose-Headers`), as POI_API does; otherwise the validator takes the seconds the
description of the answer names, as POI3 words it. A 429 has to carry `Access-Control-Allow-Origin` as well, or the
page sees only a failed request.

To try it without a server of WWCP_POI, `tools/mock-poi-server.mjs` serves a demo below the paths POI_API serves, with
CORS, and prints the trust anchor naming its own URL:

```bash
node "D:\Coding\OpenChargingCloud\WWCP_POI_Validator\tools\mock-poi-server.mjs" qa 8139
```

Paste the printed trust anchor (`http://localhost:8139/RNs/QA?keys=…`) into the validator and press *Load from its
servers*. A third argument limits the heavy reads per minute, to see the validator wait:

```bash
node "D:\Coding\OpenChargingCloud\WWCP_POI_Validator\tools\mock-poi-server.mjs" qa 8140 4
```


## The demos

- `tools/vendor-qa-demo.mjs` copies the public documents of the recorded run WWCP_POI.TS vendors into `demo/qa` and writes
  its manifest; the run and the time it is checked as of are those of `WWCP_POI.TS/tests/at.ts` (`VECTORS_RUN`, `AT`),
  so that running it again after WWCP_POI.TS moved on to a new run follows it. Its package on npm carries no test
  vectors: they are read from a checkout of WWCP_POI.TS next to the validator, at the tag of the release the validator
  takes (`v0.2.0` today), or from the path given as its argument:

  ```bash
  node "D:\Coding\OpenChargingCloud\WWCP_POI_Validator\tools\vendor-qa-demo.mjs"
  ```

- `tools/vendor-sessions-demo.mjs` copies the charging sessions of the same checkout (`tests/vectors`, since 0.2.0)
  into `demo/sessions`: five sessions as they are, and the one session of `price-publication.json` once with each of its
  13 variants of the receipts of the publication of its prices in its place, each described in the manifest; and of
  `trust-transitions.json` the proofs and transitions, in the order an app meets them; the trusted witness of the
  checkpoints and the policy of the witnesses of price publications go into the settings:

  ```bash
  node "D:\Coding\OpenChargingCloud\WWCP_POI_Validator\tools\vendor-sessions-demo.mjs"
  ```

- `tools/generate-demo-network.mjs` generates the Thuringia network: deterministic keys, pools and timestamps, the ETags,
  identifications, trees and signature inputs calculated by WWCP_POI.TS, every change set applied again by the library
  with the signatures of its owners, and at the end the whole history replayed from the trust anchor, its checkpoints,
  price statements and proofs included. What is written verifies, or nothing is written:

  ```bash
  node "D:\Coding\OpenChargingCloud\WWCP_POI_Validator\tools\generate-demo-network.mjs"
  ```


## Tests

The analysis runs in Node as in the browser, so the tests need no browser (`node:test`, a few minutes):

```bash
npm --prefix "D:\Coding\OpenChargingCloud\WWCP_POI_Validator" test
```

- `tests/demos.test.js`: both demos verify as of the time of their recording, with every commit, checkpoint, proof,
  attestation and QI-Digital document; a day later the station proofs of the QA demo are refused, their attestations
  expired; the proof of a station along the A4 says how its EVSEs are paid with EV Taler.
- `tests/tampering.test.js`: one document of the Thuringia demo changed after it was signed, as *Edit and verify again*
  does it: a change set (its commit is refused, the commits after it are not taken), a signature of the operator, a
  witness signature removed, no trust anchor, a price statement among the current ones and in the list a checkpoint
  names.
- `tests/servers.test.js`: *Load from its servers* against `tools/mock-poi-server.mjs`, and how it waits on 429.
- `tests/sessions.test.js`: every session of the sessions demo as an app checks it; receipts counted once per
  organization and only before the start; without the policy of the settings no receipt counts; the trust anchor a
  session brings, or one holder short of the quorum, gives no trust context; station proofs with two of three holders
  trusted verify, with one they are refused.
- `tests/transitions.test.js`: the trust transitions of the sessions demo verified, one refused, and the proofs of
  their targets with them, in their epoch; the journal of an app follows one way on and refuses the other as a fork,
  and takes everything of the QA and the Thuringia demo; with a holder untrusted, no transition and no proof holds.

GitHub Actions run them (`.github/workflows/verify.yml`), and then make the demos anew, which have to be the ones
committed, byte for byte; for the QA and the sessions demo with WWCP_POI.TS checked out next to the validator, at the tag
of its release:

- **CI** (`ci.yml`), on every push and pull request: with the release of WWCP_POI.TS `package-lock.json` holds, on
  Debian 13 with Node 22.18 and 26 (a container on GitHub's Ubuntu runner, as in the rest of this stack), and on
  Windows with Node 24.
- **Nightly** (`nightly.yml`): the same once more, and with WWCP_POI.TS master, built and taken instead of the release. A
  red there means WWCP_POI.TS moved on and the validator has to follow before its next release: adapt it, make the demos
  anew (`npm run vendor:qa`, `npm run vendor:sessions`, `npm run generate:thuringia`), and take the release once it is on
  npm.


## How it is built

| File | |
|---|---|
| `src/main.js` | the page: sources, settings, tabs |
| `src/sources.js` | the demos, dropped files, and the servers of a trust anchor (POI_API) |
| `src/documents.js` | what a document is, from its context or its shape; the pool of all documents |
| `src/analyze.js` | the analysis with WWCP_POI.TS: trust, history, checkpoints, epochs, proofs, prices, evidence, archive |
| `src/sessions.js` | charging sessions as an app checks them: their readings, trust context, meter key, historical evidence, prices |
| `src/transitions.js` | trust transitions, verified from the trust anchor of the settings, a later one from the one it continues |
| `src/journal.js` | what an app keeps of the versions it observed: its journal, and what it refuses |
| `src/keys.js` | who holds a key: the directory of all keys of a version |
| `src/entities.js` | the entities of a version: tree, provenance of effective values, Merkle paths, entity history |
| `src/views/*.js` | overview, trust, history, network, proofs & prices (with `qidigital.js`), sessions, documents |
| `tests/*.test.js` | the demos, documents changed after they were signed, loading from servers, sessions, trust decisions and transitions |
| `tools/*.mjs` | the QA and the sessions demo vendored, the Thuringia demo generated, a stand-in POI_API server |

Every verdict is the library's: the page only records what it checked, step by step, and goes on where it can, so that
one refused signature does not hide the rest of the history. Branches and merges, element changes and preconditions are
refused by WWCP_POI.TS as not yet supported, and shown as such.

A history starts as WWCP_POI.TS lets it start (10.5): a snapshot of a checkpoint or of the head anchored in the trust
anchor, by the signatures of the operator's quorum or by its attestations; a genesis, or the base of an archive segment,
unanchored, its key statement verified against the trust anchor here and its commit signed by the quorum.


## License

GNU Affero General Public License v3.0, as WWCP_POI and WWCP_POI.TS.

Copyright 2014-2026 GraphDefined GmbH
