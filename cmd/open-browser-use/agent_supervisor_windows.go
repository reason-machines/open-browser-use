//go:build windows

package main

import "os/exec"

func detachProcessGroup(*exec.Cmd) {}
