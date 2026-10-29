# WWCP POI Validator

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
- **Trust** — the chain from the identity keys the trust anchor pins to the key statement of the roaming network
  operator, its holders and the certificates of their signing keys; who signed how many commits, checkpoints and
  attestations; how the keys moved on (key succession, epochs); the keys of every party; the trusted witnesses.
- **History** — every epoch, where it starts (genesis, a checkpoint, an archive segment, or the genesis derived from the
  final checkpoint before) and how that start is anchored in the trust anchor (10.5), and each commit and checkpoint
  with what was checked: the identification, the parent, the change set applied again with the signatures of its owners
  (and who owns each change, section 4.1), the ETags it leads to, the quorum of the operator; for checkpoints their
  commits tree, the signatures of the operator and the witnesses, and the price statements they name. Refused documents
  are shown where they would have been, with the reason.
- **Network** — any version, effective (as proofs and apps see it) or as stored; a map of the charging pools; for each
  entity where its values come from (its own or a template, 9.2), the tariffs an EVSE takes, the groups it is a member
  of, its runtime status, the commits that changed it, and its path through the effective tree up to the root the commit
  names — the audit paths a proof of it would give.
- **Proofs & prices** — station proofs as an app checks them, with how they are pruned, the models, hardware revisions,
  firmware versions and serial numbers of the station and its meters, the certificates they name and the transparency
  software proven by them; price statements; the evidence of a charging session; proofs of commits and price statements
  in checkpoints; attestations; the archive; and the **QI-Digital** papers of meters (example A14): digital calibration
  certificates, certificates of conformity and declarations of conformity, each checked against the network and against
  each other.
- **Documents** — everything loaded, as POI reads it. A document can be **edited and verified again**: change a price, a
  power, an identification or a signature, and see which check refuses it.


## Three ways in

1. **A trust anchor** — the text of its QR code (`WWCP/TA-2:…`), its URL (`https://…/RNs/{id}?keys=…&minConsensus=2`) or
   its JSON. *Load from its servers* asks the servers it names for what POI_API serves — the epochs and their
   checkpoints, the archive, the snapshot of the first checkpoint, the head, the commits since, the attestations, the
   price statements, and the proofs of the stations you name — and checks all of it from the pinned keys alone.
2. **Documents** dropped onto the page: snapshots, commits, checkpoints, archive segments, station proofs, price
   statements, attestations, evidence, QI-Digital documents, a list of trusted witnesses. What a document is follows
   from its JSON-LD context, or from its shape. A trust anchor or a list of witnesses among them goes into the settings.
3. **Demos**:
   - **QA**, the roaming network of the WWCP_POI examples A1 to A14, one recorded run (public data only), the one
     WWCP_POI.TS vendors (`tests/vectors/csharp-33447ac` today): a quorum of three holders, one operator with 16 EVSEs,
     manufacturers and their models, transparency software and its certificates, a calibration laboratory, two epochs
     (ECDSA/SHA-256, then ML-DSA/SHA-512), witnesses, price statements, evidence, and the QI-Digital papers of a meter.
   - **Thuringia**, a generated test network of medium size: seven charging station operators, 195 charging pools,
     417 stations and 834 EVSEs on a map; change sets of several owners, a key rotation, a removed pool, a latecomer;
     four witnessed checkpoints, price statements and station proofs. Signed with test keys of fixed seeds.

   The demos are checked *as of the time of their recording*, as their attestations were valid for 15 minutes back then;
   switch the verification time to *now* in the settings to see them refused.

`index.html?demo=qa` and `index.html?demo=thuringia` start a demo right away.


## Building

The validator uses WWCP_POI.TS from a checkout next to it, until it is published on npm:

```
D:\Coding\OpenChargingCloud\WWCP_POI.TS
D:\Coding\OpenChargingCloud\WWCP_POI_Validator
```

Build WWCP_POI.TS once, then the validator:

```bash
npm --prefix "D:\Coding\OpenChargingCloud\WWCP_POI.TS" ci
```

```bash
npm --prefix "D:\Coding\OpenChargingCloud\WWCP_POI.TS" run build
```

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


## Loading from servers: CORS

A page may read the answers of a server of another origin only when the server allows it
(`Access-Control-Allow-Origin`). POI_API of WWCP_POI answers the CORS preflights of its entity routes, but not yet those
of its history, checkpoints, epochs and proofs; until it does, *Load from its servers* works with a server that adds the
header (e.g. behind a reverse proxy), or with the validator served from the same origin as POI_API.

A server may limit the heavy reads of a client — snapshots, pages of commits, archive segments — and answer one beyond
with 429 Too Many Requests and `Retry-After` (specification 5.5; POI3 takes 600 per minute). The validator then waits as
long as told, a minute at most at a time, and asks again, up to six times. Another origin reads `Retry-After` only where
the server exposes it (`Access-Control-Expose-Headers`); otherwise the validator takes the seconds the description of
the answer names, as POI3 words it. A 429 has to carry `Access-Control-Allow-Origin` as well, or the page sees only a
failed request.

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
  so that running it again after WWCP_POI.TS moved on to a new run follows it:

  ```bash
  node "D:\Coding\OpenChargingCloud\WWCP_POI_Validator\tools\vendor-qa-demo.mjs"
  ```

- `tools/generate-demo-network.mjs` generates the Thuringia network: deterministic keys, pools and timestamps, the ETags,
  identifications, trees and signature inputs calculated by WWCP_POI.TS, every change set applied again by the library
  with the signatures of its owners, and at the end the whole history replayed from the trust anchor, its checkpoints,
  price statements and proofs included. What is written verifies, or nothing is written:

  ```bash
  node "D:\Coding\OpenChargingCloud\WWCP_POI_Validator\tools\generate-demo-network.mjs"
  ```


## How it is built

| File | |
|---|---|
| `src/main.js` | the page: sources, settings, tabs |
| `src/sources.js` | the demos, dropped files, and the servers of a trust anchor (POI_API) |
| `src/documents.js` | what a document is, from its context or its shape; the pool of all documents |
| `src/analyze.js` | the analysis with WWCP_POI.TS: trust, history, checkpoints, epochs, proofs, prices, evidence, archive |
| `src/keys.js` | who holds a key: the directory of all keys of a version |
| `src/entities.js` | the entities of a version: tree, provenance of effective values, Merkle paths, entity history |
| `src/views/*.js` | overview, trust, history, network, proofs & prices (with `qidigital.js`), documents |

Every verdict is the library's: the page only records what it checked, step by step, and goes on where it can, so that
one refused signature does not hide the rest of the history. Branches and merges, element changes and preconditions are
refused by WWCP_POI.TS as not yet supported, and shown as such.

A history starts as WWCP_POI.TS lets it start (10.5): a snapshot of a checkpoint or of the head anchored in the trust
anchor, by the signatures of the operator's quorum or by its attestations; a genesis, or the base of an archive segment,
unanchored, its key statement verified against the trust anchor here and its commit signed by the quorum.


## License

GNU Affero General Public License v3.0, as WWCP_POI and WWCP_POI.TS.

Copyright 2014-2026 GraphDefined GmbH
