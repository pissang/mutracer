mod assets;
mod encode;
mod error;
mod materialx;
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
    version,
    about = "Render MuTracer shots to PNG frames and MP4 on the native GPU."
)]
struct Cli {
    #[arg(long, hide = true)]
    worker: bool,
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
