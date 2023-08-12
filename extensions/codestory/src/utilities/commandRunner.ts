import { spawn } from "child_process";

export async function runCommandAsync(
    workingDirectory: string,
    cmd: string,
    args: string[] = []
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";

        const child = spawn(cmd, args, {
            cwd: workingDirectory,
        });

        child.stdout.on("data", (data) => {
            stdout += data;
        });

        child.stderr.on("data", (data) => {
            stderr += data;
        });

        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`Command exited with code: ${code}, stderr: ${stderr}`));
            } else {
                resolve({ stdout, stderr, exitCode: code });
            }
        });

        child.on("error", (error) => {
            reject(error);
        });
    });
}
