# 08 — Data flow

Every place a value can be seen, and every edge it can travel. One rule holds the picture
together: **exactly one concern owns each value, and every other place it appears is a view.**

## The map

```mermaid
flowchart TB
    subgraph owner["Owner realm — the addon that declared the data"]
        st1["observable<br/>observable · computed"]
        cfg["config accessor tree<br/>sync · typed · scalars"]
        col["db collections<br/>sync · typed · documents · local"]
        sv["rpc methods<br/>the owner's own, authorized"]
        sh1["shared mirror<br/>own namespace + announcements"]
        ev1["events<br/>emit · delivered, not kept"]
        ui1["screens<br/>useObservable"]
    end

    subgraph peer["Peer realm — any other bedrock-core addon"]
        q["query cache<br/>data · status · staleness"]
        sh2["shared mirror<br/>read any · owner writes"]
        ev2["event listeners<br/>subscribe by ns + name"]
        st2["observable"]
        ui2["screens<br/>useObservable"]
    end

    bus{{"script-event bus<br/>@bedrock-core/sync — the only channel"}}

    subgraph dp["Persistence — dynamic properties"]
        wdp[("world DPs")]
        edp[("entity · player DPs")]
        bdp[("block-entity DPs")]
        sdp[("container-slot DPs")]
    end

    ui1 -->|"useObservable"| st1
    ui1 -->|"useObservable"| cfg
    ui1 -->|"useObservable"| col
    cfg -->|"is a"| col

    col -->|"own host, write-through"| edp
    col -->|"own host, write-through"| bdp
    col -->|"own host, write-through"| sdp
    col -->|"proxied host"| wdp

    cfg -->|"schema, once at register"| sh1
    col -->|"the owner maps a document onto a key"| sh1
    col -->|"the owner announces a happening"| ev1
    col -->|"a handler reads and writes it"| sv
    cfg -->|"nine methods, by the framework"| sv

    sh1 <-->|"deltas, owner-filtered"| bus
    ev1 -->|"one message per emit"| bus
    bus -->|"delivered once, to whoever listens"| ev2
    bus <-->|"deltas"| sh2
    sh2 -->|"warm read"| q
    q -.->|"rpc read · mutate, next tick"| bus
    bus -.->|"authorize(actor), then the handler"| sv

    ui2 -->|"useObservable"| q
    ui2 -->|"useObservable"| st2
    sh2 -->|"of(ns).get"| ui2
    ev2 -->|"marks an entry stale"| q
```

## Where a value can be seen

| Place | Concern | Sync | Survives restart | Peers see it | Authoritative? |
| --- | --- | --- | --- | --- | --- |
| an **observable** | observable | yes | no | no | yes, for what it holds |
| the **config accessor tree** | db (config is a collection) | yes | via DPs | via query | yes |
| a **db document** | db | yes | via DPs | via query | **yes** |
| the **shared mirror**, own namespace | shared | yes | no | yes, locally | yes |
| the **shared mirror**, a peer's namespace | shared | yes | no | — | **no** — a copy; writes dropped |
| a **query** | query | yes (cached) | no | — | **no** — a cache with a status |
| **dynamic properties** | persistence | yes | **yes** | any pack that guesses the key | the bytes |
| `core.node.state` | transport | yes | no | yes | raw mirror, framework keys included |
| the **bus** | transport | next tick | no | yes | no |

Deliberately absent: scoreboards (commands and JSON UI reach; nothing here uses them), and any
copy of a peer's *documents* other than a query cache.

## The transfers

### 1. Value → dynamic property (persistence)

Config and db write through on change, 17 µs a write ([S2](./spikes/S2-dynamic-property-costs.md)).
Which DP depends on the resolved host ([03-db](./03-db.md#where-a-document-can-live--capability-not-declaration)).
The mirror persists nothing: a shared value that must survive a restart is a db document the owner
maps onto a key in one line.

### 2. Announcement → mirror (discovery, push)

Small, static, owner-written: config schema, i18n bundles, guides, feature flags, host election.
Broadcast once; every realm mirrors; a UI builds a form for a peer with no round trip.

### 3. Owner write → peer caches (invalidation or warm value)

Nothing here is automatic: db is local, so a peer learns a value moved only because the owner said
so. The owner mirrors the value on a `shared` key, or emits an event, or both. A query names
whichever of the two it wants and goes stale on it the same tick — or, from a mirrored key, simply
*has* the new value. That one declared edge is what replaces polling.

### 4. Peer → owner (RPC pull and mutate)

A query that is stale, or a `mutate`, is a request to the owner; the reply arrives next tick, is
authorized by actor, and is authoritative. The owner serves; nothing else does.

## One peer write, end to end

```mermaid
sequenceDiagram
    participant U as screen in a peer realm
    participant Q as query cache
    participant B as bus
    participant O as owner's rpc handler
    participant D as dynamic property
    participant M as every listening realm

    U->>Q: mutate(patch, actorId)
    Q->>Q: apply optimistically, fetchStatus fetching
    Q->>B: rpc, the owner's write method
    B->>O: next tick
    O->>O: authorize(actor) · schema · validity gate
    O->>D: write-through, via the owner's own db
    O->>O: the document notifies its local subscribers
    O->>B: the owner's own event, if it declared one
    B->>M: delivered once, to whoever listens
    O->>B: rpc reply with the authoritative value
    B->>Q: replace cache, status success — or roll back, status error
    Q->>U: useObservable re-renders
```

Every hop is tick-bounded and appears in the content log under the owner's namespace. A local
write is the same picture with the bus removed: authorize, persist, notify, publish.
