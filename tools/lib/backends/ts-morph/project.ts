import { Project } from "ts-morph"
import { resolve } from "path"

// Cache projects by resolved tsconfig path
const projectCache = new Map<string, Project>()

/**
 * Get or create a ts-morph Project for the given tsconfig
 */
export function getProject(tsConfigPath = "tsconfig.json"): Project {
  const resolvedPath = resolve(tsConfigPath)

  let project = projectCache.get(resolvedPath)
  if (!project) {
    project = new Project({ tsConfigFilePath: resolvedPath })
    projectCache.set(resolvedPath, project)
  }
  return project
}

/**
 * Reset all cached projects (useful for tests)
 */
export function resetProject(): void {
  projectCache.clear()
}
