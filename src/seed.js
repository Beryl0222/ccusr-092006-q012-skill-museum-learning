// 用虚构种子数据填充一个全新服务实例（仅场馆资源；学校提交按需调用）。
import { readFile } from "node:fs/promises";
import { SchedulingService } from "./service.js";

export async function loadSeed(service, seedUrl = new URL("../data/seed.json", import.meta.url)) {
  const seed = JSON.parse(await readFile(seedUrl, "utf8"));
  const token = service.museumToken;
  for (const corridor of seed.corridors ?? []) await service.registerCorridor(corridor, token);
  for (const station of seed.stations ?? []) await service.registerStation(station, token);
  for (const instructor of seed.instructors ?? []) await service.registerInstructor(instructor, token);
  return seed;
}

export async function seededService(opts = {}) {
  const service = new SchedulingService(opts);
  const seed = await loadSeed(service);
  return { service, seed };
}
