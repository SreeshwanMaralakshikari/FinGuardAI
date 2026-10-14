"""
generate_data.py — synthetic, labelled payment history in FinGuardAI's own schema.

Why synthetic: public fraud datasets (PaySim, IEEE-CIS, ULB credit card) do not
contain the signals FinGuardAI scores on — customer's usual cities, usual hours,
known devices, cross-customer device reputation. A model trained on them could
not use the app's data. This generator simulates customers and attackers and
derives every feature the same way the backend does at scoring time.

How it stays honest:
  * Labels come from the SCENARIO that created a payment (legitimate customer vs
    a fraud pattern), never from the rule engine's score, so the model is not
    simply re-learning the rules.
  * Legitimate customers also travel, change phones, pay at night, make large
    one-off purchases, buy from "high-risk" merchants and make bursts of
    payments, so every fraud signal also appears on honest payments.
  * Some fraud is deliberately hard (the victim's own phone, normal amounts).
  * A small amount of label noise models disputed / mislabelled chargebacks.

Limitation (must be stated in any report): the patterns and rates below are
assumptions chosen to be plausible, not measured from real bank data. Metrics
on this data show the pipeline works; they do not prove real-world accuracy.

Feature derivation mirrors the backend (verify against the v3 code):
  * usualLocations  = top PROFILE_TOP_CITIES cities by frequency
  * usualHours      = top PROFILE_TOP_HOURS hours by frequency
  * knownDeviceIds / usualPaymentMethods = every value seen before
  * The profile is the TRUSTED baseline: the backend learns only from APPROVED,
    LOW-risk payments. Here honest payments that were approved update it; held
    honest payments and all fraud attempts do not.
  * Velocity counts ALL earlier payments of the customer, fraud included.
  * Device reputation is global per device:
        Math.round((approved + 0.5 × held + 3) / (total + 3) × 100), blacklisted if < 30

Usage:
    python -m training.generate_data --customers 4000 --days 120 --seed 42 \
        --out data/synthetic_transactions.csv
"""

from __future__ import annotations

import argparse
import bisect
import csv
import math
import os
import sys
from collections import Counter
from dataclasses import dataclass, field

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.features import CONTRACT_KEYS, PAYMENT_METHODS

# ─── Profile semantics (mirror calcBehaviorProfile) ──────────────────────────
PROFILE_TOP_CITIES = 5
PROFILE_TOP_HOURS = 3

# ─── World ───────────────────────────────────────────────────────────────────
CITIES = [
    "Hyderabad", "Mumbai", "Delhi", "Bengaluru", "Chennai", "Kolkata", "Pune",
    "Ahmedabad", "Jaipur", "Lucknow", "Kochi", "Indore", "Bhopal", "Nagpur",
    "Visakhapatnam", "Patna", "Chandigarh", "Coimbatore", "Surat", "Guwahati",
]
CITY_WEIGHTS = np.array([9, 10, 10, 9, 7, 6, 6, 5, 4, 4, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2], float)
CITY_WEIGHTS /= CITY_WEIGHTS.sum()

NORMAL_MERCHANTS = ["GENERAL", "GROCERY", "FOOD", "TRAVEL", "ELECTRONICS",
                    "UTILITIES", "FASHION", "ENTERTAINMENT", "HEALTH", "EDUCATION"]
HIGH_RISK_MERCHANTS = ["CASINO", "GAMBLING", "CRYPTO_EXCHANGE", "ADULT", "OFFSHORE_BETTING"]

METHOD_PRIORS = np.array([0.62, 0.18, 0.08, 0.12])  # UPI, CARD, NET_BANKING, WALLET
assert len(METHOD_PRIORS) == len(PAYMENT_METHODS)

LEGIT, ATO, SIM_SWAP, CARD_TESTING, CASHOUT, SOCIAL_ENG, LOW_SLOW, NEW_ACCOUNT = (
    "legit", "account_takeover", "sim_swap", "card_testing", "mule_cashout",
    "social_engineering", "low_and_slow", "new_account_fraud",
)


@dataclass
class Customer:
    cid: int
    is_fraudster: bool
    join_day: float
    home_cities: list
    city_probs: np.ndarray
    hour_peaks: list
    median_amount: float
    daily_rate: float
    method_probs: np.ndarray
    devices: list
    phone_change_day: float | None
    uses_high_risk: bool
    phone_changed: bool = False
    device_log: list = field(default_factory=list)   # (time, device) of honest payments
    # mutable state while replaying history
    times: list = field(default_factory=list)
    n_legit: int = 0
    sum_legit: float = 0.0
    max_legit: float = 0.0
    city_counts: Counter = field(default_factory=Counter)
    hour_counts: Counter = field(default_factory=Counter)
    known_devices: set = field(default_factory=set)
    known_methods: set = field(default_factory=set)


def _new_device_id(rng, prefix: str) -> str:
    return f"{prefix}-{rng.integers(16**8):08x}"


def _make_customer(cid: int, rng, days: int, is_fraudster: bool) -> Customer:
    k = rng.choice([1, 2, 3], p=[0.6, 0.3, 0.1])
    home = list(rng.choice(CITIES, size=k, replace=False, p=CITY_WEIGHTS))
    city_probs = rng.dirichlet(np.ones(k) * 2.0)
    city_probs = city_probs[np.argsort(-city_probs)]          # first city is the main one
    peaks = list(rng.choice(range(8, 22), size=2, replace=False))
    if rng.random() < 0.10:                                     # night owl
        peaks.append(int(rng.choice([23, 0, 1])))
    median = float(np.clip(rng.lognormal(math.log(900), 0.9), 50, 25_000))
    rate = float(np.clip(rng.lognormal(math.log(0.9), 0.6), 0.1, 6.0))
    method_probs = rng.dirichlet(METHOD_PRIORS * 8)
    phone_change = float(rng.uniform(0, days)) if rng.random() < 0.20 else None
    devices = [_new_device_id(rng, "dev")]
    if rng.random() < 0.25:                                     # phone + laptop
        devices.append(_new_device_id(rng, "dev"))
    return Customer(
        cid=cid,
        is_fraudster=is_fraudster,
        join_day=float(rng.uniform(0, days * 0.6)),
        home_cities=home,
        city_probs=city_probs,
        hour_peaks=peaks,
        median_amount=median,
        daily_rate=rate,
        method_probs=method_probs,
        devices=devices,
        phone_change_day=phone_change,
        uses_high_risk=bool(rng.random() < 0.04),
    )


def _legit_hour(c: Customer, rng) -> int:
    if rng.random() < 0.08:                                     # occasional off-pattern hour
        return int(rng.integers(0, 24))
    peak = rng.choice(c.hour_peaks)
    return round(rng.normal(peak, 1.6)) % 24


def _event(c, t, scenario, amount, city, device, method, merchant):
    return {"cid": c.cid, "t": t, "scenario": scenario, "amount": round(float(amount), 2),
            "city": city, "device": device, "method": method, "merchant": merchant}


NEW_BROWSER_RATE = 0.01   # FinGuardAI's deviceId is per browser: new browser / cleared storage


def _legit_device(c: Customer, rng, t: float) -> str:
    """
    Device for an honest payment at time t. c.devices holds the customer's
    ACTIVE devices (phone first, optional laptop). A phone change replaces the
    phone once; a new browser replaces one active device. Every use is logged
    so fraud scenarios can find the victim's real device at a given time.
    """
    if c.phone_change_day is not None and not c.phone_changed and t >= c.phone_change_day:
        c.devices[0] = _new_device_id(rng, "dev")
        c.phone_changed = True
    if rng.random() < NEW_BROWSER_RATE:
        c.devices[int(rng.integers(len(c.devices)))] = _new_device_id(rng, "dev")
    idx = 0 if len(c.devices) == 1 or rng.random() < 0.6 else 1
    device = c.devices[idx]
    c.device_log.append((t, device))
    return device


def _device_at(c: Customer, t: float) -> str:
    """Device of the customer's latest honest payment before t (their own phone)."""
    earlier = [(ts, dev) for ts, dev in c.device_log if ts < t]
    return max(earlier)[1] if earlier else c.devices[0]


def _legit_events(c: Customer, rng, days: int) -> list:
    events = []
    day = math.floor(c.join_day)
    travel_until = -1.0
    travel_city = None
    while day < days:
        n = rng.poisson(c.daily_rate)
        burst = rng.random() < 0.02                               # shopping spree
        if burst:
            n += int(rng.integers(3, 7))
        if travel_until < day and rng.random() < 0.012:          # start a trip
            travel_city = str(rng.choice([x for x in CITIES if x not in c.home_cities]))
            travel_until = day + int(rng.integers(1, 6))
        burst_hour = _legit_hour(c, rng)
        times = []
        for i in range(n):
            hour = burst_hour if burst else _legit_hour(c, rng)
            minute = rng.uniform(0, 60) if not burst else min(59.9, i * rng.uniform(3, 9))
            times.append(day + (hour + minute / 60) / 24)
        for t in sorted(times):              # chronological, so device history is consistent
            if t < c.join_day:
                continue
            device = _legit_device(c, rng, t)
            if travel_city and day <= travel_until:
                city = travel_city
            elif rng.random() < 0.03:
                city = str(rng.choice(CITIES, p=CITY_WEIGHTS))
            else:
                city = str(rng.choice(c.home_cities, p=c.city_probs))
            amount = rng.lognormal(math.log(c.median_amount), 0.7)
            if rng.random() < 0.03:                                # big legitimate purchase
                amount *= rng.uniform(4, 20)
            method = str(rng.choice(PAYMENT_METHODS, p=c.method_probs))
            if c.uses_high_risk and rng.random() < 0.3:  # noqa: SIM114 — kept separate so the random-draw order (and the seed-42 dataset) never changes
                merchant = str(rng.choice(HIGH_RISK_MERCHANTS))
            elif rng.random() < 0.004:
                merchant = str(rng.choice(HIGH_RISK_MERCHANTS))
            else:
                merchant = str(rng.choice(NORMAL_MERCHANTS))
            events.append(_event(c, t, LEGIT, max(1.0, amount), city, device, method, merchant))
        day += 1
    return events


def _other_city(c, rng):
    return str(rng.choice([x for x in CITIES if x not in c.home_cities]))


def _fraud_incident(c: Customer, rng, days: int, attacker_devices: list) -> list:
    """One fraud incident against victim `c`. Returns its payment events."""
    start = c.join_day + rng.uniform(3, max(4, days - c.join_day))
    if start >= days:
        return []
    scenario = rng.choice(
        [ATO, SIM_SWAP, CARD_TESTING, CASHOUT, SOCIAL_ENG, LOW_SLOW],
        p=[0.28, 0.16, 0.14, 0.14, 0.18, 0.10],
    )
    attacker_dev = str(rng.choice(attacker_devices)) if rng.random() < 0.55 else _new_device_id(rng, "atk")
    victim_dev = _device_at(c, start)
    base_day = math.floor(start)
    med = c.median_amount
    events = []

    def at(hour, minute):
        return base_day + (hour + minute / 60) / 24

    if scenario == ATO:
        hour = int(rng.integers(0, 6)) if rng.random() < 0.5 else _legit_hour(c, rng)
        city = _other_city(c, rng) if rng.random() < 0.7 else c.home_cities[0]
        n = int(rng.choice([1, 2, 3, 4], p=[0.4, 0.3, 0.2, 0.1]))
        for i in range(n):
            amount = med * rng.uniform(3, 15)
            method = "UPI" if rng.random() < 0.7 else str(rng.choice(PAYMENT_METHODS))
            events.append(_event(c, at(hour, i * rng.uniform(2, 12)), ATO, amount, city,
                                 attacker_dev, method, str(rng.choice(NORMAL_MERCHANTS))))
    elif scenario == SIM_SWAP:
        hour = _legit_hour(c, rng) if rng.random() < 0.6 else int(rng.integers(0, 24))
        city = c.home_cities[0] if rng.random() < 0.6 else _other_city(c, rng)
        n = int(rng.choice([1, 2, 3], p=[0.5, 0.3, 0.2]))
        for i in range(n):
            amount = med * rng.uniform(4, 25)
            method = str(rng.choice(["UPI", "NET_BANKING"]))
            events.append(_event(c, at(hour, i * rng.uniform(3, 15)), SIM_SWAP, amount, city,
                                 attacker_dev, method, str(rng.choice(NORMAL_MERCHANTS))))
    elif scenario == CARD_TESTING:
        hour = int(rng.integers(0, 24))
        city = _other_city(c, rng) if rng.random() < 0.6 else c.home_cities[0]
        dev = attacker_dev if rng.random() < 0.8 else victim_dev
        n = int(rng.integers(5, 16))
        for i in range(n):
            amount = rng.uniform(10, 600) if i < n - 1 else med * rng.uniform(2, 8)
            merchant = str(rng.choice(HIGH_RISK_MERCHANTS)) if rng.random() < 0.3 else str(rng.choice(NORMAL_MERCHANTS))
            events.append(_event(c, at(hour, i * rng.uniform(1, 4)), CARD_TESTING, amount, city,
                                 dev, "CARD", merchant))
    elif scenario == CASHOUT:
        hour = _legit_hour(c, rng) if rng.random() < 0.5 else int(rng.integers(0, 6))
        city = _other_city(c, rng) if rng.random() < 0.5 else c.home_cities[0]
        dev = attacker_dev if rng.random() < 0.6 else victim_dev
        n = int(rng.choice([1, 2, 3], p=[0.5, 0.3, 0.2]))
        for i in range(n):
            amount = med * rng.uniform(2, 12)
            merchant = str(rng.choice(HIGH_RISK_MERCHANTS)) if rng.random() < 0.8 else "GENERAL"
            method = str(rng.choice(["WALLET", "CARD", "UPI"]))
            events.append(_event(c, at(hour, i * rng.uniform(5, 30)), CASHOUT, amount, city,
                                 dev, method, merchant))
    elif scenario == SOCIAL_ENG:
        # Victim is tricked into paying from their OWN phone, in their own city.
        hour = _legit_hour(c, rng) if rng.random() < 0.7 else int(rng.integers(0, 24))
        n = int(rng.choice([1, 2], p=[0.7, 0.3]))
        for i in range(n):
            amount = med * rng.uniform(4, 20)
            events.append(_event(c, at(hour, i * rng.uniform(10, 40)), SOCIAL_ENG, amount,
                                 c.home_cities[0], victim_dev, "UPI", str(rng.choice(NORMAL_MERCHANTS))))
    else:  # LOW_SLOW — stolen but unlocked phone, small payments over days
        for i in range(int(rng.integers(2, 6))):
            t = start + i * rng.uniform(0.2, 1.5)
            if t >= days:
                break
            hour = _legit_hour(c, rng)
            city = _other_city(c, rng) if rng.random() < 0.5 else c.home_cities[0]
            amount = med * rng.uniform(0.8, 2.5)
            events.append(_event(c, math.floor(t) + hour / 24, LOW_SLOW, amount, city, victim_dev,
                                 str(rng.choice(PAYMENT_METHODS, p=c.method_probs)),
                                 str(rng.choice(NORMAL_MERCHANTS))))
    return events


def _new_account_events(c: Customer, rng, days: int, attacker_devices: list) -> list:
    """A fraudulent account (synthetic identity / mule) — every payment is fraud."""
    events = []
    dev = str(rng.choice(attacker_devices)) if rng.random() < 0.6 else _new_device_id(rng, "atk")
    t = c.join_day
    for _ in range(int(rng.integers(1, 7))):
        if t >= days:
            break
        hour = int(rng.integers(0, 24))
        amount = rng.lognormal(math.log(15_000), 0.8)
        merchant = str(rng.choice(HIGH_RISK_MERCHANTS)) if rng.random() < 0.5 else str(rng.choice(NORMAL_MERCHANTS))
        events.append(_event(c, math.floor(t) + (hour + rng.uniform(0, 60) / 60) / 24, NEW_ACCOUNT,
                             amount, str(rng.choice(CITIES, p=CITY_WEIGHTS)), dev,
                             str(rng.choice(PAYMENT_METHODS)), merchant))
        t += rng.uniform(0.02, 1.0)
    return events


def _reputation(stats) -> int:
    """utils/updateDeviceReputation.js: Math.round(...) to a whole number, clamped 0..100."""
    approved, held, total = stats
    return int(min(100, max(0, math.floor((approved + 0.5 * held + 3) / (total + 3) * 100 + 0.5))))


def simulate(n_customers: int, days: int, seed: int,
             noise_legit_to_fraud: float = 0.0005,
             noise_fraud_to_legit: float = 0.02) -> list[dict]:
    """
    Label noise is one-sided per class: a small share of honest payments end up
    disputed as fraud, and a share of real fraud is never reported. A single
    symmetric rate would swamp the rare fraud class with mislabelled legit rows.
    """
    rng = np.random.default_rng(seed)
    attacker_devices = [_new_device_id(rng, "atk") for _ in range(max(20, n_customers // 25))]
    customers: dict[int, Customer] = {}
    events: list[dict] = []

    for cid in range(n_customers):
        is_fraudster = bool(rng.random() < 0.025)
        c = _make_customer(cid, rng, days, is_fraudster)
        customers[cid] = c
        if is_fraudster:
            events.extend(_new_account_events(c, rng, days, attacker_devices))
            continue
        events.extend(_legit_events(c, rng, days))
        if rng.random() < 0.18:
            events.extend(_fraud_incident(c, rng, days, attacker_devices))

    events.sort(key=lambda e: e["t"])
    device_stats: dict[str, list] = {}       # device -> [approved, held, total]
    rows: list[dict] = []

    for e in events:
        c = customers[e["cid"]]
        t = e["t"]
        # +1e-9 guards float error: t = day + 7/24 must read as hour 7, not 6.999…
        hour = math.floor((t % 1) * 24 + 1e-9) % 24

        has_profile = c.n_legit > 0
        avg = c.sum_legit / c.n_legit if has_profile else 0.0
        top_cities = {x for x, _ in c.city_counts.most_common(PROFILE_TOP_CITIES)}
        top_hours = {x for x, _ in c.hour_counts.most_common(PROFILE_TOP_HOURS)}

        i_now = bisect.bisect_left(c.times, t)
        txns_last_hour = i_now - bisect.bisect_left(c.times, t - 1 / 24)
        txns_last_day = i_now - bisect.bisect_left(c.times, t - 1)

        stats = device_stats.get(e["device"])
        rep = _reputation(stats) if stats else 100
        is_fraud = e["scenario"] != LEGIT

        row = {
            "amount": e["amount"],
            "amountToAvgRatio": round(e["amount"] / avg, 4) if avg > 0 else 1.0,
            "amountToMaxRatio": round(e["amount"] / c.max_legit, 4) if c.max_legit > 0 else 1.0,
            "txnsLastHour": txns_last_hour,
            "txnsLastDay": txns_last_day,
            "isNewCity": int(bool(top_cities) and e["city"] not in top_cities),
            "isNewDevice": int(bool(c.known_devices) and e["device"] not in c.known_devices),
            "isNewPaymentMethod": int(bool(c.known_methods) and e["method"] not in c.known_methods),
            "isUnusualHour": int(bool(top_hours) and hour not in top_hours),
            "hourOfDay": hour,
            "deviceReputationScore": rep,
            "deviceIsBlacklisted": int(rep < 30),   # isBlacklisted = reputationScore < 30
            "isHighRiskMerchant": int(e["merchant"] in HIGH_RISK_MERCHANTS),
            "hasProfile": int(has_profile),
            "paymentMethod": e["method"],
            "label": int(is_fraud),
            "scenario": e["scenario"],
            "customerId": c.cid,
            "dayIndex": round(t, 5),
        }
        flip_rate = noise_fraud_to_legit if is_fraud else noise_legit_to_fraud
        if rng.random() < flip_rate:
            row["label"] = 1 - row["label"]
        rows.append(row)

        # ── state updates after scoring (the app saves the payment afterwards) ──
        bisect.insort(c.times, t)
        s = device_stats.setdefault(e["device"], [0, 0, 0])
        s[2] += 1
        if is_fraud:
            outcome = rng.choice(["approved", "held", "blocked"], p=[0.3, 0.2, 0.5])
        else:
            outcome = "approved" if rng.random() < 0.97 else "held"
        if outcome == "approved":
            s[0] += 1
        elif outcome == "held":
            s[1] += 1
        # calcBehaviorProfile learns only from APPROVED + LOW payments (trusted baseline).
        # Approximation: honest payments that were approved; never held ones or fraud.
        if not is_fraud and outcome == "approved":
            c.n_legit += 1
            c.sum_legit += e["amount"]
            c.max_legit = max(c.max_legit, e["amount"])
            c.city_counts[e["city"]] += 1
            c.hour_counts[hour] += 1
            c.known_devices.add(e["device"])
            c.known_methods.add(e["method"])

    return rows


OUTPUT_COLUMNS = list(CONTRACT_KEYS) + ["label", "scenario", "customerId", "dayIndex"]


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--customers", type=int, default=4000)
    parser.add_argument("--days", type=int, default=120)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", default="data/synthetic_transactions.csv")
    args = parser.parse_args(argv)

    rows = simulate(args.customers, args.days, args.seed)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)

    n_fraud = sum(r["label"] for r in rows)
    scen = Counter(r["scenario"] for r in rows)
    print(f"Wrote {len(rows):,} payments ({n_fraud:,} labelled fraud, "
          f"{n_fraud / len(rows):.2%}) to {args.out}")
    for name, count in scen.most_common():
        print(f"  {name:<20} {count:>8,}")


if __name__ == "__main__":
    main()
