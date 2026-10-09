# Contabo VPS — Request for Server Creation

**Purpose:** Please create the server below and send back the access details. The team lead will handle all software installation and configuration.

---

## What to order

Go to **contabo.com** and order:

| Setting | Value |
|---------|-------|
| Product | Cloud VPS 4 |
| CPU | 4 vCPU |
| RAM | 8 GB |
| Storage | 100 GB SSD |
| Traffic | Unlimited |
| Operating system | **Ubuntu 22.04** |
| Datacenter | **US East (New York / Carlstadt, NJ)** |

**Cost:** approximately **$8.08/month** on a 24-month term ($5.28 base + $2.80 US East location fee).

**Notes:**
- Contabo provisioning can take several hours on first order.
- There is no hourly billing — the server is billed monthly once created.
- Support is email-only.

---

## What to send back

After the server is provisioned, Contabo will email you the **IP address** and the **root password**. Forward these to the team lead via **Outlook email**.

Specifically:

1. Server IP address
2. Root password
3. Confirmation that the operating system is Ubuntu 22.04

Once we have those, we will handle everything else.

---

## What this server is for (context only — no action needed)

It hosts a Docker container that connects to MetaTrader brokers. Our trading worker (running on Railway) sends requests to this server, which talks to the broker and returns the results.

**Why US East (Carlstadt, NJ):** It is roughly 5 ms from New York City and about 15 ms from the New York broker servers we connect to. Latency matters for trade execution.

**Why 4 vCPU / 8 GB:** Each MetaTrader session uses roughly 35 MB of RAM (measured). 8 GB handles around 160 concurrent sessions. We will monitor usage and upgrade the plan if needed — Contabo plans can be upgraded in place without rebuilding the server.
