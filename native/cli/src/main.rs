mod assets;
mod encode;
mod error;
mod lifetime;
mod materialx;
mod quality;
mod run;
mod scene;
mod shot;
mod stdio;

use clap::{Parser, Subcommand, error::ErrorKind};
use error::Result;
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    path::PathBuf,
    process::ExitCode,
};

#[derive(Parser)]
#[command(
    name = "mutracer",
    version,
    about = "Render MuTracer shots to PNG frames and MP4 on the native GPU."
)]
struct Cli {
    #[arg(long, hide = true)]
    worker: bool,
    #[arg(long, hide = true)]
    parent_stdin: bool,
    #[command(subcommand)]
    command: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Check the shot and its assets without using a GPU.
    Validate { file: PathBuf },
    /// Render a single frame at time t.
    Still(run::Still),
    /// Render a lower-resolution, half-rate review clip.
    Preview(run::Sequence),
    /// Render a resumable numbered sequence and encode it to MP4.
    Render(run::Sequence),
    /// Turn a directory of numbered PNG files into an MP4.
    Encode {
        directory: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long)]
        fps: u32,
        #[arg(long, default_value_t = 1)]
        stride: u32,
        #[arg(long)]
        contact_sheet: Option<PathBuf>,
    },
    /// Serve native frames over the versioned binary stdio protocol.
    Serve {
        #[arg(long, required = true)]
        stdio: bool,
    },
    /// Filter a single EXR shot using companion surface guides.
    Temporal {
        frames: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long, allow_hyphen_values = true)]
        png_exposure: Option<f32>,
    },
    /// Assemble ordered PNG shot ranges with optional captions.
    Assemble {
        cut: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long)]
        font: Option<PathBuf>,
    },
    /// Convert and lint an OpenUSD scene with the optional Python adapter.
    ImportUsd {
        source: PathBuf,
        #[arg(short, long)]
        output: Option<PathBuf>,
        #[arg(long)]
        camera: Option<String>,
        #[arg(long)]
        lint: bool,
    },
    /// Print the JSON Schema for shot files.
    Schema,
    /// Print the CLI and shot-authoring guide.
    Guide,
}

fn progress(record: Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{record}");
    let _ = out.flush();
}

fn run(cli: Cli) -> Result<()> {
    if (cli.worker || cli.parent_stdin)
        && matches!(
            cli.command,
            Action::Still(_) | Action::Preview(_) | Action::Render(_)
        )
    {
        lifetime::watch_stdin();
    }
    match cli.command {
        Action::Validate { file } => run::validate(&file),
        Action::Still(args) => run::still(args, cli.worker),
        Action::Preview(args) => run::sequence(args, true, cli.worker),
        Action::Render(args) => run::sequence(args, false, cli.worker),
        Action::Encode {
            directory,
            output,
            fps,
            stride,
            contact_sheet,
        } => {
            let frames = encode::sequence(&directory)?;
            if let Some(path) = contact_sheet {
                encode::contact_sheet(&frames, &path)?;
                progress(json!({"event":"contactSheet","path":path}));
            }
            if encode::encode(&frames, &output, encode::Rate { fps, stride })? {
                progress(json!({"event":"encoded","path":output,"frames":frames.len()}));
            } else {
                let message = "ffmpeg was unavailable. PNG frames are ready to encode.";
                eprintln!("{message}");
                progress(json!({"event":"sequence","path":directory,"message":message}));
            }
            Ok(())
        }
        Action::Serve { stdio: _ } => stdio::serve(),
        Action::Temporal {
            frames,
            output,
            png_exposure,
        } => quality::temporal(&frames, &output, png_exposure),
        Action::Assemble { cut, output, font } => quality::assemble(&cut, &output, font.as_deref()),
        Action::ImportUsd {
            source,
            output,
            camera,
            lint,
        } => {
            if !lint && output.is_none() {
                return Err(error::Error::validation(
                    "/output",
                    "Expected -o SHOT.json",
                    "Use --lint to check without writing a shot.",
                ));
            }
            let python = std::env::var_os("MUTRACER_PYTHON").unwrap_or_else(|| {
                if cfg!(windows) {
                    "python".into()
                } else {
                    "python3".into()
                }
            });
            let mut command = std::process::Command::new(python);
            command.args(["-m", "mutracer.usd"]).arg(source);
            if let Some(output) = output {
                command.arg("-o").arg(output);
            }
            if let Some(camera) = camera {
                command.arg("--camera").arg(camera);
            }
            if lint {
                command.arg("--lint");
            }
            let status = command
                .status()
                .map_err(|e| error::Error::asset("/source", e.to_string()))?;
            match status.code() {
                Some(0) => Ok(()),
                Some(2) => Err(error::Error::validation(
                    "/source",
                    "OpenUSD lint failed",
                    "See the located USD error above.",
                )),
                _ => Err(error::Error::at(
                    3,
                    "/source",
                    "OpenUSD import failed",
                    "Install the Python frontend with the usd extra, or set MUTRACER_PYTHON to a Python with pxr.",
                )),
            }
        }
        Action::Schema => {
            print!("{}", shot::SCHEMA);
            Ok(())
        }
        Action::Guide => {
            print!("{}", include_str!("../guide.md"));
            Ok(())
        }
    }
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) => {
            let print_only = matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion);
            let _ = e.print();
            return if print_only {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(2)
            };
        }
    };
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::to_string(&error).expect("serializable CLI error")
            );
            ExitCode::from(error.code)
        }
    }
}
