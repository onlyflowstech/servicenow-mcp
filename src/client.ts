/**
 * ServiceNow HTTP client — native fetch-based, zero external dependencies.
 *
 * @module client
 */

import { ServiceNowConfig } from "./config.js";

export interface ServiceNowError {
  message: string;
  detail?: string;
  status?: number;
}

export class ServiceNowClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(private config: ServiceNowConfig) {
    this.baseUrl = config.instance;
    this.authHeader =
      "Basic " +
      Buffer.from(`${config.user}:${config.password}`).toString("base64");
  }

  // ── Core HTTP methods ──────────────────────────────────────────

  async get(path: string, params?: Record<string, string>): Promise<any> {
    const url = this.buildUrl(path, params);
    return this.request("GET", url);
  }

  async post(path: string, body?: unknown): Promise<any> {
    const url = this.buildUrl(path);
    return this.request("POST", url, body);
  }

  async patch(path: string, body?: unknown): Promise<any> {
    const url = this.buildUrl(path);
    return this.request("PATCH", url, body);
  }

  async put(path: string, body?: unknown): Promise<any> {
    const url = this.buildUrl(path);
    return this.request("PUT", url, body);
  }

  async delete(path: string): Promise<{ status: number }> {
    const url = this.buildUrl(path);
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
      },
    });

    if (!response.ok && response.status !== 204) {
      const errorBody = await this.parseErrorBody(response);
      throw this.createError(
        errorBody?.message || `Delete failed with HTTP ${response.status}`,
        errorBody?.detail,
        response.status
      );
    }

    return { status: response.status };
  }

  /**
   * POST binary data (for attachment uploads).
   */
  async postBinary(
    path: string,
    data: Buffer,
    contentType: string,
    params?: Record<string, string>
  ): Promise<any> {
    const url = this.buildUrl(path, params);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": contentType,
      },
      body: new Uint8Array(data),
    });

    if (!response.ok) {
      const errorBody = await this.parseErrorBody(response);
      throw this.createError(
        errorBody?.message || `Request failed with HTTP ${response.status}`,
        errorBody?.detail,
        response.status
      );
    }

    return response.json();
  }

  /**
   * GET raw response (for attachment downloads).
   */
  async getRaw(path: string): Promise<{ data: Buffer; contentType: string }> {
    const url = this.buildUrl(path);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
      },
    });

    if (!response.ok) {
      throw this.createError(
        `Download failed with HTTP ${response.status}`,
        undefined,
        response.status
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    return { data: buffer, contentType };
  }

  // ── Internal helpers ───────────────────────────────────────────

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  private async request(method: string, url: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await this.parseErrorBody(response);
      throw this.createError(
        errorBody?.message || `Request failed with HTTP ${response.status}`,
        errorBody?.detail,
        response.status
      );
    }

    // 204 No Content
    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  private async parseErrorBody(
    response: Response
  ): Promise<{ message?: string; detail?: string } | null> {
    try {
      const text = await response.text();
      const json = JSON.parse(text);
      // ServiceNow error format
      if (json.error) {
        return {
          message: json.error.message || json.error,
          detail: json.error.detail,
        };
      }
      return { message: text };
    } catch {
      return null;
    }
  }

  private createError(
    message: string,
    detail?: string,
    status?: number
  ): ServiceNowError {
    return { message, detail, status };
  }
}
