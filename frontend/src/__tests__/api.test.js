import { speedLabel, normPort, buildPortLinkMap } from "../api.js";

test("speedLabel returns correct tiers", () => {
  expect(speedLabel(100000)).toBe("100G");
  expect(speedLabel(40000)).toBe("40G");
  expect(speedLabel(25000)).toBe("25G");
  expect(speedLabel(10000)).toBe("10G");
  expect(speedLabel(1000)).toBe("1G");
  expect(speedLabel(100)).toBe("100M");
  expect(speedLabel(10)).toBe("10M");
  expect(speedLabel(0)).toBe("?");
});

test("normPort trims and lowercases", () => {
  expect(normPort("  Eth1/1  ")).toBe("eth1/1");
  expect(normPort(null)).toBe("");
  expect(normPort(undefined)).toBe("");
  expect(normPort("")).toBe("");
  expect(normPort("GigabitEthernet0/1")).toBe("gigabitethernet0/1");
});

test("buildPortLinkMap creates keyed lookup", () => {
  const links = [
    { local_ip: "10.0.0.1", local_port: "Eth1/1", remote_ip: "10.0.0.2", remote_port: "Eth1/2" },
  ];
  const m = buildPortLinkMap(links);
  expect(m["10.0.0.1:eth1/1"]).toBeDefined();
  expect(m["10.0.0.1:eth1/1"].role).toBe("from");
  expect(m["10.0.0.2:eth1/2"]).toBeDefined();
  expect(m["10.0.0.2:eth1/2"].role).toBe("to");
});
