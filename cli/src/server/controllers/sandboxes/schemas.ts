import { z } from "zod";

export const ErrorSchema = z.object({
  error: z.string().describe("Error code"),
  message: z.string().describe("Human-readable message"),
});

export const CreateSandboxBodySchema = z.object({
  templateID: z.string().optional().describe("Template image ID"),
  timeout: z.number().optional().describe("Timeout in seconds"),
  envVars: z.record(z.string(), z.string()).optional().describe("Environment variables"),
  metadata: z.record(z.string(), z.string()).optional().describe("Arbitrary metadata"),
});

export const SandboxResponseSchema = z.object({
  sandboxID: z.string().describe("Sandbox identifier"),
  templateID: z.string().describe("Template used"),
  clientID: z.string().describe("Client identifier"),
  envdVersion: z.string().describe("envd daemon version"),
  envdAccessToken: z.string().describe("Token for envd access"),
  trafficAccessToken: z.string().nullable().describe("Traffic access token"),
  domain: z.string().nullable().describe("Custom domain"),
});

export const SandboxDetailSchema = z.object({
  sandboxID: z.string().describe("Sandbox identifier"),
  templateID: z.string().describe("Template used"),
  clientID: z.string().describe("Client identifier"),
  envdVersion: z.string().describe("envd daemon version"),
  domain: z.string().nullable().describe("Custom domain"),
  startedAt: z.string().describe("ISO 8601 creation timestamp"),
  endAt: z.string().describe("ISO 8601 expiry timestamp"),
  metadata: z.record(z.string(), z.string()).optional().describe("Arbitrary metadata"),
});

export const ConnectBodySchema = z.object({
  timeout: z.number().optional().describe("New timeout in seconds"),
});

export const TimeoutBodySchema = z.object({
  timeout: z.number().describe("New timeout in seconds"),
});

export const SandboxIdParamSchema = z.object({
  sandboxID: z.string().describe("Sandbox identifier"),
});
