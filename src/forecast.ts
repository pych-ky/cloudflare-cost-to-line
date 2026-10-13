const DAY_MS = 86_400_000;

export interface DailyCost {
  date: string;
  amountUsd: number;
  complete: boolean;
}

export interface MonthlyForecast {
  recordedUsd: number;
  recordedComplete: boolean;
  estimatedUsd: number | null;
  dataThrough: string | null;
  unavailableReason: string | null;
}

export function forecastMonthlyCost(
  days: readonly DailyCost[],
  monthStart: Date,
  monthEnd: Date,
  now: Date,
): MonthlyForecast {
  const start = monthStart.getTime();
  const end = monthEnd.getTime();
  const completeBefore = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const daily = new Map(days.map((day) => [Date.parse(`${day.date}T00:00:00Z`), day]));
  const monthly = days.filter((day) => {
    const timestamp = Date.parse(`${day.date}T00:00:00Z`);
    return timestamp >= start && timestamp < end && timestamp < completeBefore;
  });
  const recordedUsd = monthly.reduce((sum, day) => sum + day.amountUsd, 0);
  const completed = [...daily.keys()].filter((day) => day < completeBefore && day < end);
  const latest = completed.length ? Math.max(...completed) : null;
  const result: MonthlyForecast = {
    recordedUsd,
    recordedComplete: false,
    estimatedUsd: null,
    dataThrough: latest === null ? null : new Date(latest).toISOString().slice(0, 10),
    unavailableReason: null,
  };

  if (latest === null || (completeBefore > start && monthly.length === 0)) {
    return { ...result, unavailableReason: "当月のデータなし" };
  }

  // 計上日までの穴と、集計がまだ終わっていない後続の日を区別する。
  for (let day = start; day <= latest; day += DAY_MS) {
    if (!daily.get(day)?.complete) {
      return { ...result, unavailableReason: "当月データに欠測あり" };
    }
  }
  result.recordedComplete = monthly.length > 0;

  let recentTotal = 0;
  for (let offset = 0; offset < 7; offset++) {
    const day = daily.get(latest - offset * DAY_MS);
    if (!day?.complete) {
      return { ...result, unavailableReason: "連続した7日分のデータ不足" };
    }
    recentTotal += day.amountUsd;
  }
  if (recentTotal === 0) {
    return { ...result, unavailableReason: "直近7日の計上額は0ドル。今後の無料枠超過を予測できません" };
  }

  const remainingDays = Math.max(0, Math.round((end - Math.max(start, latest + DAY_MS)) / DAY_MS));
  return { ...result, estimatedUsd: recordedUsd + (recentTotal / 7) * remainingDays };
}
